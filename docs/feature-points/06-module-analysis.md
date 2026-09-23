# module-analysis toolkit

Standalone, lives in `toolkits/module-analysis/`. `analyze-modules.ts` (Node, using `@opencode-ai/sdk`) starts one real opencode server for the whole run and sends it one `agent: "plan"` prompt per module subdirectory of a large codebase, producing an architecture-map doc per module. Concurrency-limited (all concurrent runs share the one server), resumable (skips modules with a non-empty output file already), edit/write denied by permission so the analyzing agent can't touch the code it's analyzing.

**Tested:** `tests/integration/analyze-modules.test.mjs`, run against a real opencode server (the SDK's `createOpencode()`) with a fake local OpenAI-compatible HTTP server standing in for the model provider — no real model or network needed. Covers the happy path, a failed module leaving no output but a captured log, and the resumability/skip logic for an already-analyzed module (asserted by request count to the fake provider, not just by file state).
