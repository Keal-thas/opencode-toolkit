# oracle mcp server

A minimal MCP server exposing one tool, `oracle_query`, that runs an arbitrary SQL statement against a configured Oracle database and returns the result as JSON. Written in TypeScript (`src/server.ts` + `src/types/config.ts`, compiled to `dist/` — see Run below), built directly against `@modelcontextprotocol/sdk` and `oracledb` (thin mode, no Oracle Instant Client needed — works fully offline), same hand-rolled-against-the-raw-API pattern as `plugins/`. Speaks MCP over Streamable HTTP, as a persistent process opencode connects to (`type: "remote"`) rather than spawns and owns (`type: "local"`) — see below for why.

## Design, and why it looks the way it does

- **Remote, not local.** A `local`/stdio server would have opencode spawning and owning the process, tying the server's uptime to opencode's own restarts. Instead this runs as a persistent HTTP server, started independently (`npm start` under a process supervisor — see `deploy/opencode.json.example`/SETUP.md step 6) and reachable at a fixed URL. Still runs on the same machine as opencode in this repo's deployment — "remote" describes the connection model, not a different host.
- **Stateless HTTP, one `Server`/transport pair per request** (`sessionIdGenerator: undefined`, matching the SDK's own reference example). No session state is worth keeping between calls — each `oracle_query` is already a fresh, independent Oracle connection (below) — so sharing one pair across requests would only let concurrent requests interfere with each other for no benefit.
- **Full passthrough, by design.** `oracle_query` executes whatever SQL it's given — no read-only enforcement, no keyword filtering, DDL/DML included. Safety is meant to live elsewhere: the DB account's own grants, and the `auditQuery()` hook in `src/server.ts` — currently a no-op that allows everything, a drop-in point for a rule-based or LLM-based check later (mirroring `plugins/llm-review-gate/llm-review-gate.ts`'s gate).
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

Config is file-based, not env-var-based (unlike `loki/`/`java-lsp/`/`spring-lsp/`) — two separate files, matching how the port (infrastructure, fixed per machine) and the database connection (per-environment: prod/staging/dev/...) actually vary independently:

- **`$HOME/.config/kealthas-dev/opencode-mcp-oracle/server.json`** — the port to listen on, at this one fixed path always. Optional: if missing, defaults to `8090`; if present, must be valid JSON or the server refuses to start. Shape (see `server.example.json`):
  ```json
  { "ORACLE_MCP_PORT": 8090 }
  ```
- **A database config file at whatever path the `ORACLE_CONFIG_FILE` env var points at** — filename and location are unrestricted (absolute, `~`-relative, or relative to the current directory all work), so one install can be pointed at any environment just by changing this one env var per launch. Required — the server prints a sample and exits if `ORACLE_CONFIG_FILE` is unset, the file doesn't exist, or it's missing a required key. Shape (see `config.example.json`):
  ```json
  {
    "ORACLE_CONNECT_STRING": "hostname:1521/service_name",
    "ORACLE_USER": "username",
    "ORACLE_PASSWORD": "password"
  }
  ```
  `ORACLE_CONNECT_STRING` accepts either an Easy Connect string (`host:port/service_name`) or a full TNS descriptor — both are passed straight through to `oracledb.getConnection()`, which supports both natively. Not a JDBC URL either way.

A typical multi-environment layout:

```
~/.config/kealthas-dev/opencode-mcp-oracle/
├── server.json                    # port - one per machine
└── configs/
    ├── prod.json                  # ORACLE_CONFIG_FILE=~/.config/kealthas-dev/opencode-mcp-oracle/configs/prod.json
    ├── staging.json
    └── dev.json
```

Real credentials never need to live inside this repo's checkout at all (unlike the other three servers' `.env`, which needs the `mcp-servers/**/.env` `.gitignore` rule to stay out of git) — the config directory lives under `$HOME`, entirely outside the working tree.

## Run

Published as `@kealthas-dev/opencode-mcp-oracle` — on a real deployment, install it globally and run the resulting binary (see SETUP.md step 6):

```bash
npm install -g @kealthas-dev/opencode-mcp-oracle
ORACLE_CONFIG_FILE=~/.config/kealthas-dev/opencode-mcp-oracle/configs/prod.json opencode-mcp-oracle
```

For local dev/testing against this repo's own checkout (this directory, not the published package), point `ORACLE_CONFIG_FILE` at a real database config file (see `config.example.json` for the shape — the sandbox's docker-entrypoint.sh generates one automatically, see Testing below):

```bash
npm install
npm run build
ORACLE_CONFIG_FILE=/path/to/a/real/config.json npm start
```

`npm run dev` runs `src/server.ts` directly via `tsx watch` instead, for a compile-on-save loop.

Either way, this starts a persistent HTTP server on the configured port (default `8090`), serving MCP over Streamable HTTP at `/mcp`. Point opencode at it with a `type: "remote"` entry (see `deploy/opencode.json.example`) — it needs to already be running and stay running, since opencode connects rather than spawns it (either command alone exits when its terminal closes; see Design above for real supervisor options).

## Testing against a real Oracle instance

`docker/docker-compose.oracle.yml`'s `oracle` service (`gvenzl/oracle-free` — see `docker/docker-notes.md`'s "Oracle test instance" section) is a shared fixture started separately, not by `docker/dev.sh`:

```sh
docker compose -f docker/docker-compose.oracle.yml up -d --wait
docker/dev.sh run --rm opencode-dev bash
```

`ORACLE_CONFIG_FILE` is already set inside that shell — `docker-entrypoint.sh` generates a database config file from the sandbox's `ORACLE_CONNECT_STRING`/`ORACLE_USER`/`ORACLE_PASSWORD` compose env vars and points `ORACLE_CONFIG_FILE` at it, matching a real deployment's file-based config rather than passing those three straight through. `cd mcp-servers/oracle && npm install && npm run build && npm start`, then hit `http://localhost:8090/mcp` from an MCP client or `curl`.

`oracle.test.ts` (see `tests/README.md`) doesn't need this manual dance — it builds against `process.env.ORACLE_CONNECT_STRING`/`ORACLE_USER`/`ORACLE_PASSWORD` (still plain env vars at the test level) to write its own config files into a fake `$HOME` per spawned server, and starts/stops its own `dist/server.js` process on its own port as part of the test run.

## Status

**Verified end-to-end and automated.** `oracle.test.ts` covers tool listing, a plain SELECT, a write surviving the per-request connection close (autoCommit), a nonexistent-table error path, and a connection-failure regression (an earlier bug crashed the MCP protocol instead of returning a clean error) — driven over the real Streamable HTTP transport against the sandbox's `oracle` service. Wired into `deploy/opencode.json.example` (`mcp.oracle`, `type: "remote"`, `enabled: true` — see SETUP.md step 6). The `auditQuery()` hook remains an intentional no-op until a rule-based or LLM-based check is designed for it.

The Streamable HTTP implementation is verified against the pinned SDK version (`@modelcontextprotocol/sdk@1.30.0`, per `package-lock.json`) by reading its compiled `.d.ts`/`.js`, not only by following docs examples.
