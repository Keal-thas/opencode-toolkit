# Deployment environment

Background facts about the upstream project, the target machine, and the model this repo's `deploy/`/`SETUP.md` setup targets. Linked from [CLAUDE.md](../CLAUDE.md)'s "Where things live".

## opencode upstream

[anomalyco/opencode](https://github.com/anomalyco/opencode) (`dev` branch), npm package `opencode-ai`.

- Agent definitions: `packages/opencode/src/agent/agent.ts`.
- `explore`/`compaction`/`summary`/`title` each load their own native prompt from `packages/opencode/src/agent/prompt/*.txt`; `build`, `plan`, and `general` have **no prompt field set in source at all** (confirmed against 1.14.30, re-confirmed 2026-09-13 against 1.18.30 — re-check on future upgrades rather than assuming it still holds).
- Permission logic: `packages/opencode/src/permission/index.ts`.
- Task tool (subagent invocation): `packages/opencode/src/tool/task.ts` + `task.txt`.
- Base-prompt-by-model-ID selection: `packages/opencode/src/session/system.ts`.

## Two machines, don't conflate them

1. **The restricted/offline machine** — single-user, Windows, git-bash, no public internet. Where SETUP.md actually gets executed (also used via `web`/`serve` modes, not just CLI — all interfaces read the same `opencode.json`). opencode is already installed via `npm install -g opencode-ai`. **Confirmed 2026-09-17 (Franco, high confidence): this machine has a working internal npm registry reachable over the intranet, for downloading only — it cannot be used to publish/release this repo's own code.** "No internet" only ever meant no public/external access. This is why `mcp-servers/oracle/`/`mcp-servers/loki/`'s third-party npm dependencies (`@modelcontextprotocol/sdk`, `oracledb`) install directly via `npm install` (SETUP.md steps 6/7) — the registry is a full mirror of public npm, not a curated subset — and the same mirror resolves `plugins/`'s own packages by bare name too, since those are published to the public registry as well. **Confirmed 2026-09-26 (Franco): PyPI is also reachable from this machine, and its Python is standard CPython** — resolves the open question SETUP.md step 12 (`mcp-servers/redis/`) previously flagged about `uv`/`uvx` needing a different registry than the npm mirror above; no separate PyPI mirror/proxy setup needed, and no exotic-interpreter wheel-compatibility concern for `redis-mcp-server`'s C-extension dependencies (`cryptography`/`pydantic-core`/`aiohttp`/`numpy`).
2. **A separate vLLM model-serving machine**, reachable over the restricted machine's internal network. Franco has no admin access, only consumes it as an API client; no multi-user file-contention concern on the opencode side.

The target machine's model server exposes an **OpenAI-compatible API** — relevant for the `provider` block in `opencode.json`; opencode supports OpenAI-compatible providers natively.

## The model: Qwen3.6-35B-A3B

Real, released 2026-04-16, Apache 2.0, sparse MoE — postdates the knowledge cutoff, don't rely on training-data recall.

- Native context 262,144 tokens, extensible to 1,010,000 via RoPE scaling — but **the actual deployed context is confirmed by Franco at only 128K** (2026-09-18, chat, high confidence — not yet traced to a specific vLLM flag like `--max-model-len`). Treat 128K as the real ceiling for anything context-budget-sensitive until the gap is explained.
- Has a "thinking preservation" feature (retains reasoning traces across multi-turn) — worth checking whether `opencode.json`'s model config sets `reasoning`/`interleaved` to use it.
- Hardware specs of the model server unknown. `$CONFIG_DIR` on the restricted machine is opencode's default (no override).
- **Known quirk, not an opencode/repo issue**: a "tool call not supported" error was hit on one smaller Qwen model ("qwen2.7b", exact model unconfirmed). Not fixable from this repo's prompt override; if it recurs, check vLLM's `--tool-call-parser` flag.

## models.dev catalog fetch

Doesn't block startup on a fully offline machine — a build-time snapshot is embedded in the offline binary. Only cosmetic fallout is an hourly failed-fetch log line; silence with `OPENCODE_DISABLE_MODELS_FETCH=1`, and add `OPENCODE_MODELS_PATH=<path>` (pointing at `deploy/models-dev-snapshot.json`, see SETUP.md step 3) for fresher data — both vars are needed together. Doesn't matter much either way: this setup's Qwen provider is defined by hand in `opencode.json`, not looked up from the catalog at all.
