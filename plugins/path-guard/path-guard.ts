import { statSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

// Two guards on the path arguments of opencode's file-reading tools. Both run
// in tool.execute.before, mutating output.args in place (reassigning
// output.args would be silently discarded, see docs/lessons-learned.md).
//
// 1. A small model often writes an absolute path with directory segments
//    dropped (/home/u/Work/Project for /home/u/Work/Parent/Child/Project). The
//    call then fails, or for a path outside the workspace stops on a permission
//    prompt. If exactly one existing path inside the workspace explains the
//    guess, use it.
// 2. grep silently ignores a search path that does not exist and searches the
//    whole workspace instead, and glob fails with a bare "ripgrep execution
//    failed". Both are replaced by an error naming the missing path.

// Argument names that carry a path, per tool. `read` is only repaired: it already reports a missing file clearly.
const PATH_ARGS: Record<string, string[]> = { read: ["filePath"], glob: ["path"], grep: ["path"] };
const SEARCH_TOOLS = new Set(["glob", "grep"]);

type PathOps = Pick<typeof path, "isAbsolute" | "resolve" | "join" | "sep">;

const defaultExists = (p: string) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

// Only a plain ENOENT counts as missing: a permission or I/O error says nothing about whether the path exists.
const isMissing = (p: string) => {
  try {
    statSync(p);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
};

// Map a guessed absolute path onto the workspace, or return null. Not exported: opencode loads every export of a plugin module as a plugin (a function export is called with the plugin input, any other export fails the load), so the unit test appends an export to a copy of this file instead. The anchor is the
// longest tail of the workspace path (ending in its last segment) that occurs in the
// guess; it must occur exactly once, and the whole remainder of the guess after it
// must exist under the workspace. Nothing is ever trimmed or invented: any doubt
// returns null and the call proceeds as the model wrote it.
function rescuePath(raw: string, workspace: string, ops: PathOps = path, exists: (p: string) => boolean = defaultExists): string | null {
  const sep = ops.sep;
  const root = ops.resolve(workspace);
  const resolved = ops.resolve(raw);
  if (resolved === root || resolved.startsWith(root + sep)) return null; // already inside the workspace: a real absence, not a guess
  // Windows treats / as a separator too, and compares names case-insensitively.
  const guess = (sep === "/" ? raw : raw.replaceAll("/", sep)).split(sep).filter(Boolean);
  if (guess.some((s) => s === "." || s === "..")) return null;
  const fold = sep === "/" ? (s: string) => s : (s: string) => s.toLowerCase();
  const rootSegs = root.split(sep).filter(Boolean);

  for (let len = rootSegs.length; len >= 1; len--) {
    const anchor = rootSegs.slice(rootSegs.length - len).map(fold);
    const at: number[] = [];
    for (let i = 0; i + len <= guess.length; i++) {
      if (anchor.every((seg, j) => fold(guess[i + j]) === seg)) at.push(i);
    }
    if (at.length === 0) continue; // a shorter anchor may still match
    if (at.length > 1) return null; // ambiguous
    const candidate = [root, ...guess.slice(at[0] + len)].join(sep);
    return exists(candidate) ? candidate : null;
  }
  return null;
}

export const PathGuard: Plugin = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => {
    const keys = PATH_ARGS[input.tool];
    const args = output.args as Record<string, unknown> | undefined;
    if (!keys || !args) return;
    for (const key of keys) {
      const given = args[key];
      if (typeof given !== "string" || given === "") continue;
      let target: string = given;
      if (path.isAbsolute(target) && isMissing(target)) {
        const rescued = rescuePath(target, directory);
        if (rescued) args[key] = target = rescued;
      }
      if (SEARCH_TOOLS.has(input.tool) && isMissing(path.resolve(directory, target))) {
        throw new Error(
          `${input.tool}: the search path does not exist: ${path.resolve(directory, target)}. Check the path, or leave it out to search the workspace (${directory}).`,
        );
      }
    }
  },
});
