# Automated tests

Covers this workspace's feature points with tests that don't require the real vLLM + Qwen model server (none of it is reachable from here anyway - see [docs/deployment-environment.md](../docs/deployment-environment.md)). What's covered, per top-level feature:

- **System-prompt override** (`deploy/opencode.json.example` + `deploy/system-prompt.txt`) - `unit/config-consistency.test.mjs` checks the example config's JSON validity and that it doesn't drift from SETUP.md's inline copy; `integration/docker-prompt-override.test.sh` spins up a real container and asserts `opencode debug config` resolves the override correctly.
- **`system-prompt-tools.ts` plugin** - `unit/system-prompt-tools.test.mjs` checks the prompt-dump hook's output and that each run overwrites rather than appends. See `docs/feature-points/02-system-prompt-tools-plugin.md`.
- **`hook-logger.ts` plugin** - `unit/hook-logger.test.mjs` checks each hook event gets its own append-only JSONL file, and that circular payloads serialize instead of throwing.
- **`llm-review-gate.ts` plugin** - `unit/llm-review-gate.test.mjs` drives it with a fake client (no real session, no model): ALLOW/BLOCK verdicts, non-gated tools skipped, no self-review, fail-open on error.
- **`gitbash-edit-path-fix.ts` plugin** - `unit/gitbash-edit-path-fix.test.mjs` checks the Git-Bash/Cygwin/WSL path-conversion helper (all four recognized forms plus negative cases), the `tool.execute.before` hook rewriting the `edit` tool's `filePath` in place while ignoring every other tool, and an end-to-end reproduction of `packages/opencode/src/tool/edit.ts`'s own buggy `path.isAbsolute` line via `path.win32`. `process.platform` is temporarily overridden to exercise the `win32`-only branch, since this sandbox is Linux and can't reach it natively - see `docs/feature-points/18-gitbash-edit-path-fix-plugin.md`.
- **Plugin npm-install mechanism** (`plugins/*` - each its own published npm package, referenced by bare name, see CLAUDE.md and SETUP.md steps 4/5) - verified by hand in the `docker/` sandbox: a genuine `npm install` against the registry, cached, skipped on a warm cache. Not covered by an automated test - see `docker/docker-notes.md`'s "Plugin loading" section.
- **`toolkits/module-analysis/analyze-modules.ts`** - `integration/analyze-modules.test.mjs` runs the real driver against a real opencode server with a fake local model provider: the happy path, a failed module leaving a log but no output, and skip-on-resume logic for an already-analyzed module.
- **Shell scripts generally** (`docker/docker-entrypoint.sh`, `docs/fetch-opencode-docs.sh`) - `unit/shell-syntax.test.mjs` runs `bash -n` over all of them.
- **`mcp-servers/oracle/`** - `oracle.test.ts` (lives here, not under `tests/unit`, for its own `node_modules` - see its header comment) builds and spawns the compiled server with its own fake `$HOME`, drives it over real Streamable HTTP: tool listing, a SELECT, a write-survives-autoCommit round-trip, a nonexistent-table error, and a connection-failure regression. Needs a real Oracle instance (see `docker/docker-notes.md`'s "Oracle test instance" section).
- **`mcp-servers/loki/`** - `loki.test.ts`, same shape, seeding data via Loki's push API since its tools are read-only: label/value discovery, a content match, an empty result, and malformed LogQL. Needs a real Loki instance (see `docker/docker-notes.md`'s "Loki test instance" section).
- **opencode memory MCP** (the official `@modelcontextprotocol/server-memory` package - not our own code, see `docs/feature-points/15-opencode-memory-mcp.md`) - `tests/integration/mcp-memory/memory.test.mjs` spawns the real package over stdio: tool listing, a create/search round-trip that checks the file is actually written to disk, and a delete showing up in a fresh read. `unit/config-consistency.test.mjs` separately checks the `opencode.json.example` wiring.
- **`mcp-servers/java-lsp/`/`mcp-servers/spring-lsp/` - NOT part of `./tests/run-all.sh`.** Their tests exist and pass against a real `jdtls`/`spring-boot-language-server` process each, but the sandbox image has no JDK, so they aren't wired into `tests/run-in-container.sh` (the TypeScript build itself is still verified there - `tsc` needs no JDK). Run manually: `cd mcp-servers/java-lsp && npm install && npm run build && npm test` (needs `jdtls` on `PATH`); `cd mcp-servers/spring-lsp && npm install && npm run build && node --test spring-lsp.test.mjs` (needs a JDK 21+ `java`). See each package's README Status section for what's actually verified.

Not covered: `docs/fetch-opencode-docs.sh`'s actual GitHub fetch (would hit the network on every run for no benefit), and anything requiring the real vLLM + Qwen server.

## Running the tests

**Development and testing for this repo always happen inside the `docker/` sandbox, never against the host's own node/opencode install** - see CLAUDE.md. The one entry point:

```bash
./tests/run-all.sh
```

This builds the dev image if needed, then runs everything in two stages:

1. `docker/dev.sh run --rm opencode-dev bash tests/run-in-container.sh` - unit tests plus the `analyze-modules.ts` integration test, executed *inside* the dev container. Always via `docker/dev.sh`, not `docker compose` directly, so concurrent worktrees don't collide (see `docker/docker-notes.md`'s "Per-worktree isolation" section).
2. `tests/integration/docker-prompt-override.test.sh` - the one exception to "everything runs in the container," since it's what invokes `docker run` in the first place. It starts its own disposable container with a throwaway `HOME` (a real dev session's config is never at risk); everything it asserts on still runs inside that container.

To run just the container-side suite (e.g. while iterating, without the slower Docker-launching test):

```bash
docker/dev.sh run --rm opencode-dev bash tests/run-in-container.sh
```
