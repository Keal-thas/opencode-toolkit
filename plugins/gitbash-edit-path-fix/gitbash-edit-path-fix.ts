import type { Plugin } from "@opencode-ai/plugin";

// Works around anomalyco/opencode#22799 for the "edit" tool only. On the
// offline target machine (Windows + Git Bash, see docs/deployment-environment.md),
// Git Bash/MSYS/Cygwin/WSL report absolute paths as e.g. "/c/Users/franco/file.ts"
// instead of "C:\Users\franco\file.ts". Node's path.win32.isAbsolute() treats a
// leading "/" as already absolute (root-relative, no drive letter) - so
// packages/opencode/src/tool/edit.ts's
//   const filePath = path.isAbsolute(params.filePath) ? params.filePath : path.join(instance.directory, params.filePath)
// takes the "already absolute" branch and hands that literal string straight to
// fs.stat/fs.readFile/fs.writeFile, which Windows then resolves against the
// *current* drive (e.g. "D:\c\Users\franco\file.ts") instead of "C:\...".
// packages/opencode/src/tool/read.ts doesn't have this problem because it runs
// the result through FSUtil.normalizePath() (which itself runs fs-util.ts's
// windowsPath() first) before touching the filesystem; edit.ts never does -
// this asymmetry (read works, edit doesn't) is what sent us looking in the
// first place.
//
// A fix for exactly this existed once - anomalyco/opencode#22800 - but that PR
// was closed without merging (`mergedAt: null`, confirmed via `gh pr view`), so
// it never landed. Rather than fork/patch opencode itself (out of scope: this
// deployment installs opencode from npm, it doesn't build it from source), this
// plugin reproduces the same fix as a `tool.execute.before` hook that rewrites
// the "edit" tool's `filePath` argument before the real tool runs.
//
// Why mutating `output.args.filePath` (a property) works, not reassigning
// `output.args` itself: verified against anomalyco/opencode's dev branch,
// packages/opencode/src/session/tools.ts:99-133. The tool's own `execute(args, options)`
// closure calls `plugin.trigger("tool.execute.before", {...}, { args })` and then,
// on the very next line, `item.execute(args, ctx)` - same `args` variable, same
// object reference wrapped (not copied) into `{ args }`. packages/opencode/src/plugin/index.ts's
// `trigger()` then calls every registered plugin's hook against that one shared
// `output` object in sequence. So a property write on `output.args` is visible
// to the real tool call afterward; `output.args = somethingElse` would only
// rebind the temporary wrapper's property and never reach the outer `args`
// variable `item.execute` actually reads. This is almost certainly also the
// root cause behind the still-open anomalyco/opencode#42409 ("tool.execute.before
// hook: modifying output.args.command does not affect the executed command").
//
// Scope: "edit" only, per instruction. "write" has the identical
// `path.isAbsolute(...) ? ... : path.join(...)` bug (packages/opencode/src/tool/write.ts)
// and "apply_patch" has an analogous one via `path.resolve()` on each hunk's path
// (packages/opencode/src/tool/apply_patch.ts) - both left for later, see TODO.md.
// apply_patch is the harder of the two: the path isn't a discrete tool argument,
// it's embedded inside the patch text's "*** Update File: <path>" headers, so
// fixing it needs a small text rewrite/parser instead of a single field mutation.
const PATCHED_TOOLS = new Set(["edit"]);

/**
 * Converts a Git-Bash/MSYS/Cygwin/WSL-style drive-rooted absolute path into a
 * real Windows path, e.g. "/c/Users/x" -> "C:/Users/x". Returns undefined when
 * `value` doesn't match any of the recognized forms (including when it's
 * already an ordinary Windows or POSIX path) - the caller treats that as "leave
 * it alone".
 *
 * Mirrors anomalyco/opencode's packages/core/src/fs-util.ts `windowsPath()`
 * exactly: same four patterns, same order (order matters - each pattern's
 * anchoring keeps them mutually exclusive, see the plugin's own test file for
 * why "/cygdrive/c/..." can't be mis-caught by the plainer "/c/..." pattern).
 * Deliberately has no `process.platform` check of its own, unlike the
 * upstream original - that check lives in the hook below instead, so this
 * function stays a pure string transform that can be unit-tested on any host
 * OS (see gitbash-edit-path-fix.test.mjs).
 */
export function toWindowsPath(value: string): string | undefined {
  const converted = value
    .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`);
  return converted === value ? undefined : converted;
}

export const GitBashEditPathFix: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      // Real gate for production: this deployment's target machine is Windows
      // (see docs/deployment-environment.md), and on any other platform these
      // path forms are either not ambiguous (POSIX) or not produced by the
      // shell at all, so there's nothing to fix.
      if (process.platform !== "win32") return;
      if (!PATCHED_TOOLS.has(input.tool)) return;
      const filePath = output.args?.filePath;
      if (typeof filePath !== "string") return;
      const converted = toWindowsPath(filePath);
      if (converted === undefined) return;
      output.args.filePath = converted;
    },
  };
};
