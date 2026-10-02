# hook-logger

Logs essentially every opencode hook event (chat, tool execution, permission asks, compaction, …) as JSONL, one append-only file per hook, under `~/opencode-hook-output/<hook-name>.jsonl`. A debugging/observability aid with no connection to the prompt override.

- Package: `@kealthas-dev/opencode-hook-logger`, source `hook-logger.ts`.
- Enabled by default in `deploy/opencode.json.example`; independent of `llm-review-gate` and every other plugin. SETUP.md step 5.
- Circular payloads are serialized safely instead of throwing.

Tests: `tests/unit/hook-logger.test.mjs` (per-hook file routing, append across calls, circular references).
