# oracle mcp server

A minimal MCP server exposing one tool, `oracle_query`, that runs an arbitrary SQL statement against a configured Oracle database and returns the result as JSON. Built directly against `@modelcontextprotocol/sdk` and `oracledb` (thin mode, no Oracle Instant Client needed — works fully offline), same hand-rolled-against-the-raw-API pattern as `plugins/`. Speaks MCP over Streamable HTTP, as a persistent process opencode connects to (`type: "remote"`) rather than spawns and owns (`type: "local"`) — see below for why.

## Design, and why it looks the way it does

- **Remote, not local.** A `local`/stdio server would have opencode spawning and owning the process, tying the server's uptime to opencode's own restarts. Instead this runs as a persistent HTTP server, started independently (`npm start` under a process supervisor — see `deploy/opencode.json.example`/SETUP.md step 6) and reachable at a fixed URL. Still runs on the same machine as opencode in this repo's deployment — "remote" describes the connection model, not a different host.
- **Stateless HTTP, one `Server`/transport pair per request** (`sessionIdGenerator: undefined`, matching the SDK's own reference example). No session state is worth keeping between calls — each `oracle_query` is already a fresh, independent Oracle connection (below) — so sharing one pair across requests would only let concurrent requests interfere with each other for no benefit.
- **Full passthrough, by design.** `oracle_query` executes whatever SQL it's given — no read-only enforcement, no keyword filtering, DDL/DML included. Safety is meant to live elsewhere: the DB account's own grants, and the `auditQuery()` hook in `server.js` — currently a no-op that allows everything, a drop-in point for a rule-based or LLM-based check later (mirroring `plugins/llm-review-gate/llm-review-gate.ts`'s gate).
- **One Oracle connection per request**, opened and closed within the call, not pooled. A stray DML statement can't outlive its request (closing a session with uncommitted work rolls it back); concurrent calls never race on the same session; a session killed on the DB side only fails the one request in flight. Cost: connection-setup latency on every call — fine for a low-QPS internal tool, not for anything latency-sensitive.
- **`autoCommit: true`** on every execute — otherwise a successful UPDATE/INSERT would report no error and then silently roll back the moment its connection closes right after (immediately, given one connection per request).

## Recommended read-only account

Since `oracle_query` is a full passthrough with no code-level restriction (see Design above), the account `ORACLE_USER`/`ORACLE_PASSWORD` point at is the actual safety boundary. Create a dedicated account for it rather than pointing this server at an account that also has write access:

```sql
CREATE USER readonly IDENTIFIED BY "<a real password>";

GRANT CREATE SESSION, READ ANY TABLE, SELECT ANY SEQUENCE,
      FLASHBACK ANY TABLE, SELECT_CATALOG_ROLE, SELECT ANY DICTIONARY,
      EXECUTE_CATALOG_ROLE
TO readonly;
```

A few things confirmed against a real Oracle 23ai Free instance (this repo's own `docker/docker-compose.oracle.yml` sandbox), not just assumed from Oracle's docs:

- `READ ANY TABLE` genuinely blocks locking reads too — `SELECT ... FOR UPDATE` fails with `ORA-41900`, on top of `INSERT`/`UPDATE`/`DELETE`/DDL all failing — stricter than the more commonly-used `SELECT ANY TABLE`.
- `SELECT ANY DICTIONARY` does **not** expose `SYS.USER$` (password hashes) or other similarly hardened SYS tables — Oracle hardcodes that protection regardless of grants, so this combination doesn't leak credential material.
- `EXECUTE_CATALOG_ROLE` is broader than its name suggests for a read-only setup: it grants `EXECUTE` on 115 SYS packages, not just the `DBMS_METADATA` package a DDL-extraction use case actually needs — includes `DBMS_LOCK`, `DBMS_FILE_TRANSFER`, `DBMS_REDEFINITION`, `DBMS_RLS` among others. Included above as an accepted tradeoff for this deployment; a narrower alternative if only DDL text is needed is `GRANT EXECUTE ON DBMS_METADATA TO readonly;` in place of the whole role.

See `mcp-servers/TODO.md` for planned follow-ups that go further than DB grants alone (a result-size cap, `SET TRANSACTION READ ONLY` as an independent session-level guard, `CURRENT_SCHEMA` support).

## Configuration

Copy `.env.example` to `.env` and fill in real values, or set them however the process supervisor that starts this server (see Run below) is configured. A `remote` MCP entry in `opencode.json` carries no `environment` field (just a `url`) — opencode never starts this process, so wherever it actually gets started is what needs these set:

- `ORACLE_CONNECT_STRING` — an Oracle Easy Connect string (`host:port/service_name`), not a JDBC URL
- `ORACLE_USER`
- `ORACLE_PASSWORD`
- `ORACLE_MCP_PORT` — port to listen on (optional, defaults to `8090`)

## Run

Published as `@kealthas-dev/opencode-mcp-oracle` — on a real deployment, install it globally and run the resulting binary (see SETUP.md step 6):

```bash
npm install -g @kealthas-dev/opencode-mcp-oracle
ORACLE_CONNECT_STRING=... ORACLE_USER=... ORACLE_PASSWORD=... opencode-mcp-oracle
```

For local dev/testing against this repo's own checkout (this directory, not the published package):

```bash
npm install
npm start
```

Either way, this starts a persistent HTTP server on `ORACLE_MCP_PORT` (default `8090`), serving MCP over Streamable HTTP at `/mcp`. Point opencode at it with a `type: "remote"` entry (see `deploy/opencode.json.example`) — it needs to already be running and stay running, since opencode connects rather than spawns it (either command alone exits when its terminal closes; see Design above for real supervisor options).

## Testing against a real Oracle instance

`docker/docker-compose.oracle.yml`'s `oracle` service (`gvenzl/oracle-free` — see `docker/docker-notes.md`'s "Oracle test instance" section) is a shared fixture started separately, not by `docker/dev.sh`:

```sh
docker compose -f docker/docker-compose.oracle.yml up -d --wait
docker/dev.sh run --rm opencode-dev bash
```

`ORACLE_CONNECT_STRING`/`ORACLE_USER`/`ORACLE_PASSWORD` are already set inside that shell — `cd mcp-servers/oracle && npm install && npm start`, then hit `http://localhost:8090/mcp` from an MCP client or `curl`.

`oracle.test.mjs` (see `tests/README.md`) doesn't need this manual dance — it starts and stops its own `server.js` process on its own port as part of the test run.

## Status

**Verified end-to-end and automated.** `oracle.test.mjs` covers tool listing, a plain SELECT, a write surviving the per-request connection close (autoCommit), a nonexistent-table error path, and a connection-failure regression (an earlier bug crashed the MCP protocol instead of returning a clean error) — driven over the real Streamable HTTP transport against the sandbox's `oracle` service. Wired into `deploy/opencode.json.example` (`mcp.oracle`, `type: "remote"`, `enabled: true` — see SETUP.md step 6). The `auditQuery()` hook remains an intentional no-op until a rule-based or LLM-based check is designed for it.

The Streamable HTTP implementation is verified against the pinned SDK version (`@modelcontextprotocol/sdk@1.30.0`, per `package-lock.json`) by reading its compiled `.d.ts`/`.js`, not only by following docs examples.
