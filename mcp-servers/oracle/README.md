# oracle mcp server

A minimal MCP server exposing one tool, `oracle_query`, that runs an arbitrary SQL statement against a configured Oracle database and returns the result as JSON. Built directly against `@modelcontextprotocol/sdk` and `oracledb` (thin mode, no Oracle Instant Client needed — works fully offline), same hand-rolled-against-the-raw-API pattern as `plugins/`. Speaks MCP over Streamable HTTP, as a persistent process opencode connects to (`type: "remote"`) rather than spawns and owns (`type: "local"`) — see below for why.

## Design, and why it looks the way it does

- **Remote, not local.** A `local`/stdio server would have opencode spawning and owning the process, tying the server's uptime to opencode's own restarts. Instead this runs as a persistent HTTP server, started independently (`npm start` under a process supervisor — see `deploy/opencode.json.example`/SETUP.md step 5) and reachable at a fixed URL. Still runs on the same machine as opencode in this repo's deployment — "remote" describes the connection model, not a different host.
- **Stateless HTTP, one `Server`/transport pair per request** (`sessionIdGenerator: undefined`, matching the SDK's own reference example). No session state is worth keeping between calls — each `oracle_query` is already a fresh, independent Oracle connection (below) — so sharing one pair across requests would only let concurrent requests interfere with each other for no benefit.
- **Full passthrough, by design.** `oracle_query` executes whatever SQL it's given — no read-only enforcement, no keyword filtering, DDL/DML included. Safety is meant to live elsewhere: the DB account's own grants, and the `auditQuery()` hook in `server.js` — currently a no-op that allows everything, a drop-in point for a rule-based or LLM-based check later (mirroring `plugins/llm-review-gate/llm-review-gate.ts`'s gate).
- **One Oracle connection per request**, opened and closed within the call, not pooled. A stray DML statement can't outlive its request (closing a session with uncommitted work rolls it back); concurrent calls never race on the same session; a session killed on the DB side only fails the one request in flight. Cost: connection-setup latency on every call — fine for a low-QPS internal tool, not for anything latency-sensitive.
- **`autoCommit: true`** on every execute — otherwise a successful UPDATE/INSERT would report no error and then silently roll back the moment its connection closes right after (immediately, given one connection per request).

## Configuration

Copy `.env.example` to `.env` and fill in real values, or set them however the process supervisor that starts this server (see Run below) is configured. A `remote` MCP entry in `opencode.json` carries no `environment` field (just a `url`) — opencode never starts this process, so wherever it actually gets started is what needs these set:

- `ORACLE_CONNECT_STRING` — an Oracle Easy Connect string (`host:port/service_name`), not a JDBC URL
- `ORACLE_USER`
- `ORACLE_PASSWORD`
- `ORACLE_MCP_PORT` — port to listen on (optional, defaults to `8090`)

## Run

```bash
npm install
npm start
```

Starts a persistent HTTP server on `ORACLE_MCP_PORT` (default `8090`), serving MCP over Streamable HTTP at `/mcp`. Point opencode at it with a `type: "remote"` entry (see `deploy/opencode.json.example` and SETUP.md step 5) — it needs to already be running and stay running, since opencode connects rather than spawns it (`npm start` alone exits when its terminal closes; see Design above for real supervisor options).

## Testing against a real Oracle instance

`docker/docker-compose.oracle.yml`'s `oracle` service (`gvenzl/oracle-free` — see `docker/docker-notes.md`'s "Oracle test instance" section) comes up automatically via `docker/dev.sh`, no separate step needed:

```sh
docker/dev.sh run --rm opencode-dev bash
```

`ORACLE_CONNECT_STRING`/`ORACLE_USER`/`ORACLE_PASSWORD` are already set inside that shell — `cd mcp-servers/oracle && npm install && npm start`, then hit `http://localhost:8090/mcp` from an MCP client or `curl`. First time on a fresh machine/volume, the `run` command itself takes 1-3 minutes before the shell opens (Oracle's first-time DB init).

`oracle.test.mjs` (see `tests/README.md`) doesn't need this manual dance — it starts and stops its own `server.js` process on its own port as part of the test run.

## Status

**Verified end-to-end and automated.** `oracle.test.mjs` covers tool listing, a plain SELECT, a write surviving the per-request connection close (autoCommit), a nonexistent-table error path, and a connection-failure regression (an earlier bug crashed the MCP protocol instead of returning a clean error) — driven over the real Streamable HTTP transport against the sandbox's `oracle` service. Wired into `deploy/opencode.json.example` (`mcp.oracle`, `type: "remote"`, `enabled: true` — see SETUP.md step 6). The `auditQuery()` hook remains an intentional no-op until a rule-based or LLM-based check is designed for it.

The Streamable HTTP implementation is verified against the pinned SDK version (`@modelcontextprotocol/sdk@1.30.0`, per `package-lock.json`) by reading its compiled `.d.ts`/`.js`, not only by following docs examples.
