# hook-logger.ts plugin

Lives in `plugins/`. Logs essentially every opencode hook event (chat, tool execution, permission asks, compaction, etc.) as JSONL under `~/opencode-hook-output/<hook-name>.jsonl` — a general-purpose debugging/observability plugin, independent of the prompt override. Written in TypeScript against `@opencode-ai/plugin`'s `Plugin` type (the official SDK) rather than an untyped raw hook object.

**Deployment:** own npm package at `plugins/hook-logger/` (`package.json`), published to the public npm registry as `@kealthas-dev/opencode-hook-logger` and referenced as a bare `@kealthas-dev/opencode-hook-logger` (no version) — opencode's npm-plugin loader installs it itself. Included by default in `deploy/opencode.json.example`'s `plugin` array, independently removable from `llm-review-gate/` — see `docs/feature-points/02-system-prompt-tools-plugin.md` for the mechanism.

**Tested:** `tests/unit/hook-logger.test.mjs` — per-hook-name file routing, append-not-overwrite across calls, circular-reference-safe serialization.
