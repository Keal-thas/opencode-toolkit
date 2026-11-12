import type { Plugin } from "@opencode-ai/plugin";
import { rewritePatchText, toWindowsPath } from "./path-convert.ts";

// Works around anomalyco/opencode#22799 on Windows + Git Bash. Git Bash/MSYS/
// Cygwin/WSL report absolute paths as e.g. "/c/Users/franco/file.ts" instead of
// "C:\Users\franco\file.ts". Node's path.win32.isAbsolute() treats a leading
// "/" as already absolute (root-relative, no drive letter), so the tools that
// branch on `path.isAbsolute(params.filePath) ? params.filePath : path.join(...)`
// - edit.ts and write.ts - pass that literal string to fs, which Windows then
// resolves against the *current* drive (e.g. "D:\c\Users\franco\file.ts")
// instead of "C:\...". apply_patch.ts has the analogous bug via
// `path.resolve(instance.directory, hunk.path)` on each hunk's path.
//
// read.ts doesn't have this problem because it runs the result through
// FSUtil.normalizePath() (which itself runs fs-util.ts's windowsPath() first)
// before touching the filesystem; the three tools above never do.
//
// A fix for exactly this existed once - anomalyco/opencode#22800 - but that PR
// was closed without merging, so it never landed. Rather than fork/patch
// opencode itself, this plugin reproduces the same fix as a
// `tool.execute.before` hook:
//   - edit/write: rewrite `output.args.filePath`.
//   - apply_patch: rewrite the `*** Add File:` / `*** Delete File:` /
//     `*** Update File:` / `*** Move to:` header paths in `output.args.patchText`.
//
// Mutating `output.args` in place (not reassigning it) is required: opencode
// passes the same `args` object reference to the hook wrapper and then to the
// real tool, so a property write is visible afterward while `output.args = ...`
// would only rebind the wrapper's property.
const FIELD_TOOLS = new Set(["edit", "write"]);
const TEXT_TOOLS = new Set(["apply_patch"]);

export const GitBashEditPathFix: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      // Real gate for production: this deployment's target machine is Windows
      // (see docs/deployment-environment.md), and on any other platform these
      // path forms are either not ambiguous (POSIX) or not produced by the
      // shell at all, so there's nothing to fix.
      if (process.platform !== "win32") return;
      if (FIELD_TOOLS.has(input.tool)) {
        const filePath = output.args?.filePath;
        if (typeof filePath !== "string") return;
        const converted = toWindowsPath(filePath);
        if (converted === undefined) return;
        output.args.filePath = converted;
        return;
      }
      if (TEXT_TOOLS.has(input.tool)) {
        const patchText = output.args?.patchText;
        if (typeof patchText !== "string") return;
        output.args.patchText = rewritePatchText(patchText);
      }
    },
  };
};
