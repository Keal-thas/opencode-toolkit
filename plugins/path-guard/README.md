# path-guard

Two guards on the path arguments of opencode's `read`, `grep` and `glob` tools. Why these are hooks and not prompt lines: [docs/design-philosophy.md](../../docs/design-philosophy.md). Where the ideas come from: [docs/multi-agent-prior-art.md](../../docs/multi-agent-prior-art.md).

- Package: `@kealthas-dev/opencode-path-guard`, source `path-guard.ts`.
- Not yet published and not in `deploy/opencode.json.example`; see `TODO.md`. Until then it works as a hand-copied file in a plugins directory.

## Guessed absolute paths

A small model often writes an absolute path with directory segments dropped, `/home/u/Work/Project` for `/home/u/Work/Parent/Child/Project`. The call then fails, and for a path outside the workspace it first stops on an `external_directory` permission prompt, which a headless `opencode run` auto-rejects.

When the argument is an absolute path that does not exist, is not already inside the workspace and has no `.` or `..` segment, the plugin looks for the longest tail of the workspace path (always ending in its last directory) that occurs in the guess. If that tail occurs exactly once and the workspace joined with everything after it exists, the argument is rewritten to that path. Otherwise nothing changes. It never invents a path and never trims the rest of the guess, so a guess whose remainder does not exist is left alone. Only a plain `ENOENT` counts as missing; a permission error says nothing about whether the path exists.

The logic is a pure function that takes the `path` module as a parameter, so the Windows flavor (backslashes, forward slashes, case-insensitive names), which is the deployment target, is tested on Linux.

## Missing search path

Checked against opencode 1.18.33: `grep` with a `path` that does not exist does not fail, it ignores the path and searches the whole workspace, and answers as if it had searched the one asked for. `glob` with such a path fails with the bare `ripgrep execution failed`. Both are replaced by an error naming the resolved path. `read` needs nothing, since it already reports `File not found: <path>`.

## Notes

- The hooks mutate `output.args` in place; reassigning `output.args` would be discarded by opencode.
- Other tools, and calls without a path argument, are untouched.
- Out of scope: Git-Bash style paths (`/c/Users/...`) on Windows, which are handled for `edit` by [`gitbash-edit-path-fix`](../gitbash-edit-path-fix/README.md).

## Tests

`tests/unit/path-guard.test.mjs`: the pure function for posix and win32 paths (dropped parents, the root, doubts that must return nothing), and the hook against a real temporary directory (rewrite in place, paths and tools left alone, the missing-search-path error). `tests/integration/guard-plugins.test.mjs` runs it in a real opencode against a fake model: a guessed path is repaired before the read runs (which also shows that mutating `output.args` in place takes effect), and a `grep` with a missing path gets the error.
