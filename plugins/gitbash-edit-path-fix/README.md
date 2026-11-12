# gitbash-edit-path-fix

Works around an opencode bug on Windows + Git Bash: `edit` and `write` never re-resolve Git-Bash/MSYS/Cygwin/WSL-style absolute paths such as `/c/Users/x/file.ts`, and `apply_patch` resolves the same form against the current drive. Node's `path.win32.isAbsolute()` already calls that "absolute" (root-relative, no drive letter), so the tools pass the literal string to `fs`, which Windows resolves against the *current* drive instead of the intended one. `read` is unaffected because it runs its path through `FSUtil.normalizePath()` first. Full investigation, including the closed-without-merge upstream fix (`anomalyco/opencode#22800`): `docs/lessons-learned.md`.

- Package: `@kealthas-dev/opencode-gitbash-edit-path-fix`, source `gitbash-edit-path-fix.ts`, helpers `path-convert.ts`.
- Hooks `tool.execute.before`:
  - `edit` and `write`: rewrites `args.filePath` the way opencode's own `windowsPath()` does.
  - `apply_patch`: rewrites the `*** Add File:` / `*** Delete File:` / `*** Update File:` / `*** Move to:` header paths in `args.patchText`.
  - It mutates the existing `args` object in place rather than reassigning `output.args`, because the real tool reads the same `args` object right after the hook (source citation in the file's header comment). No-op off `win32`.
- The helpers live in `path-convert.ts` rather than the plugin entry file: opencode 1.19.x calls every exported function of a plugin module as a plugin factory, so exporting them from the entry file breaks loading. Tests import them from `path-convert.ts`.
- Not yet published and not in `deploy/opencode.json.example`, see `TODO.md`.

Tests: `tests/unit/gitbash-edit-path-fix.test.mjs` covers the conversion for all four path forms plus negatives, the in-place rewrite for `edit`/`write`, the `apply_patch` header rewrite, and an end-to-end reproduction of `edit.ts`'s branch via `path.win32`. It overrides `process.platform` because the sandbox is Linux, so it proves the plugin's logic, not that real Windows opencode honours the mutation. `tests/capability-probes/gitbash-edit-path-fix.probe.mjs` is the real check (Windows only) and `.github/workflows/probe-gitbash-path-bug.yml` runs it on a Windows runner.
