# mysql mcp server

A minimal MCP server exposing one tool, `mysql_query`, that runs an ad-hoc SQL statement against a configured MySQL database — inside a `START TRANSACTION READ ONLY` on every call, unconditionally — and returns the result as JSON. Written in TypeScript (`src/server.ts` + `src/types/config.ts`, compiled to `dist/` — see Run below), built directly against `@modelcontextprotocol/sdk` and `mysql2` (pure JS driver, no native bindings), same hand-rolled-against-the-raw-API pattern as `mcp-servers/oracle/`. Speaks MCP over Streamable HTTP, as a persistent process opencode connects to (`type: "remote"`) rather than spawns and owns (`type: "local"`) — see below for why.

## Design, and why it looks the way it does

- **Remote, not local.** Same reasoning as `mcp-servers/oracle/`: a persistent HTTP server, started independently (`npm start` under a process supervisor — see `deploy/opencode.json.example`/SETUP.md) and reachable at a fixed URL, rather than a `local`/stdio server whose uptime opencode itself would own.
- **Stateless HTTP, one `Server`/transport pair per request** (`sessionIdGenerator: undefined`, matching the SDK's own reference example) — no session state worth keeping between calls, since each `mysql_query` is already a fresh, independent connection (below).
- **One MySQL connection per request**, opened and closed within the call, not pooled — same three reasons as `mcp-servers/oracle/`: a stray statement can't outlive its request, concurrent calls never race on the same session, and a session killed DB-side only fails the one request in flight. Cost: connection-setup latency on every call — fine for a low-QPS internal tool.
- **Every query runs inside `START TRANSACTION READ ONLY` — this is the enforcement mechanism, not a keyword filter.** No SQL parsing, no allow/deny list of statement keywords (unlike the app-level "query validation" most community MySQL MCP servers use — see "Why not the popular community servers" below); the guarantee comes from MySQL itself. Confirmed against a real MySQL 8 instance (this repo's own `docker/docker-compose.mysql.yml` sandbox), not assumed from docs:
  - It **unconditionally** blocks DML — `INSERT`/`UPDATE`/`DELETE` all fail immediately with `ERROR 1792 (25006): Cannot execute statement in a READ ONLY transaction`, even for an account with full write privileges.
  - It does **not** block DDL. `CREATE TABLE`/`DROP TABLE`/`ALTER TABLE` all succeed anyway, because DDL implicitly commits whatever transaction is open *before* running — which takes it outside the read-only transaction entirely. Closing this residual gap needs the connecting account's own grants too — see "Recommended read-only account" below.
- **No keyword filtering beyond that transaction.** The `auditQuery()` hook in `src/server.ts` is a no-op extension point for a rule-based or LLM-based check later (mirroring `plugins/llm-review-gate/llm-review-gate.ts`'s gate), same as `mcp-servers/oracle/`.
- **Single statement only** — `mysql2` doesn't run stacked (`;`-separated) statements unless `multipleStatements: true` is passed at connection time, which this server never does.

## Recommended read-only account

`mysql_query`'s `START TRANSACTION READ ONLY` wrapper already makes DML impossible unconditionally (see Design above) — but it doesn't block DDL, so the connecting account still shouldn't have `CREATE`/`DROP`/`ALTER`/`EXECUTE` grants if a hard guarantee against schema changes (or side-effecting stored routines) is wanted too. Create a dedicated account for it rather than pointing this server at one with those privileges:

```sql
CREATE USER 'readonly'@'%' IDENTIFIED BY '<a real password>';
GRANT SELECT, SHOW VIEW, PROCESS ON *.* TO 'readonly'@'%';
FLUSH PRIVILEGES;
```

Confirmed against a real MySQL 8 instance: an account with only this grant gets `... command denied to user` for `CREATE`, `INSERT`, `DROP`, and `EXECUTE` (stored routines) alike, regardless of transaction mode — closing exactly the DDL gap the transaction wrapper leaves open. `SHOW VIEW` lets `SHOW CREATE VIEW` work; `PROCESS` lets `SHOW PROCESSLIST` see other sessions' queries, not just its own — drop either if not needed.

### Why not the popular community MySQL MCP servers

Surveyed before writing this one (see `mcp-servers/TODO.md`): the most-starred option (`designcomputer/mysql_mcp_server`) explicitly allows `INSERT`/`UPDATE`/`DELETE` through its `execute_sql` tool — not read-only at all. A smaller one (`dpflucas/mysql-mcp-server`, marketed as read-only) enforces it with a regex/keyword allowlist over the query string (`isReadOnlyQuery()` in its `validators.ts`) — application-level string matching, not something MySQL itself enforces, and it doesn't account for e.g. a `SELECT` that calls a side-effecting stored function. This server enforces read-only the way MySQL itself can: `START TRANSACTION READ ONLY`, unconditionally, on every call — no query text to fool. The one thing that mechanism can't cover (DDL) is closed by the account's grants instead, same "safety lives in the DB account too" stance `mcp-servers/oracle/` takes for everything.

## Configuration

Same file-based shape as the other `mcp-servers/*` packages — see `mcp-servers/oracle/README.md`'s Configuration section for the full rationale (port vs. connection info varying independently, why the config path is a bare env name rather than an arbitrary path, re-read on every query).

- **`$HOME/.config/kealthas-dev/opencode-mcp-mysql/server.json`** — the port to listen on. `MYSQL_MCP_PORT` env var overrides it. Optional: defaults to `8094` if missing. Shape (see `server.example.json`):
  ```json
  { "MYSQL_MCP_PORT": 8094 }
  ```
- **A database config file, re-read on every query.** `MYSQL_CONFIG_ENV` selects it the same way `ORACLE_CONFIG_ENV` does for Oracle — unset reads `config.json`, `MYSQL_CONFIG_ENV=prod` reads `config-prod.json`. Shape (see `config.example.json`):
  ```json
  {
    "MYSQL_CONNECT_STRING": "mysql://username:password@hostname:3306/database_name"
  }
  ```
  A single URI, passed straight to `mysql2`'s `createConnection()`, which parses it natively — no hand-rolled host/port/user splitting. **Any reserved character in the password — `@ : / ? #` or a space — must be percent-encoded first** (e.g. a literal `@` becomes `%40`), since those characters are also the URI's own delimiters; an unencoded one gets parsed as part of the host instead of the password, and the connection fails in a confusing way (wrong host/port, not an auth error). The database segment in the path is optional; when present it's the default, and `mysql_query`'s own optional `database` argument overrides it per call (`USE database` before the agent's SQL).

## Run

Published as `@kealthas-dev/opencode-mcp-mysql`:

```bash
npm install -g @kealthas-dev/opencode-mcp-mysql
mkdir -p ~/.config/kealthas-dev/opencode-mcp-mysql
# real config at ~/.config/kealthas-dev/opencode-mcp-mysql/config.json (see config.example.json for the shape)
opencode-mcp-mysql
```

For local dev/testing against this repo's own checkout:

```bash
npm install
npm run build
npm start   # reads ~/.config/kealthas-dev/opencode-mcp-mysql/config.json
```

`npm run dev` runs `src/server.ts` directly via `tsx watch` instead, for a compile-on-save loop.

Either way, this starts a persistent HTTP server on the configured port (default `8094`), serving MCP over Streamable HTTP at `/mcp`. Point opencode at it with a `type: "remote"` entry (see `deploy/opencode.json.example`) — it needs to already be running and stay running, since opencode connects rather than spawns it.

## Testing against a real MySQL instance

`docker/docker-compose.mysql.yml`'s `mysql` service (official `mysql` image — see `docker/docker-notes.md`'s "MySQL test instance" section) is a shared fixture started separately, not by `docker/dev.sh`:

```sh
docker compose -f docker/docker-compose.mysql.yml up -d --wait
docker/dev.sh run --rm opencode-dev bash
```

The default config file is already in place inside that shell — `docker-entrypoint.sh` builds `MYSQL_CONNECT_STRING` from the sandbox's `MYSQL_HOST`/`MYSQL_USER`/`MYSQL_PASSWORD`/`MYSQL_DATABASE` compose env vars (throwaway sandbox fixtures with no reserved URI characters, so no percent-encoding needed there) and writes `~/.config/kealthas-dev/opencode-mcp-mysql/config.json`. `cd mcp-servers/mysql && npm install && npm run build && npm start`, then hit `http://localhost:8094/mcp` from an MCP client or `curl`.

`mysql.test.ts` (see `tests/README.md`) doesn't need this manual dance — it builds the same connect string from `process.env.MYSQL_HOST`/`MYSQL_USER`/`MYSQL_PASSWORD`/`MYSQL_DATABASE` to write its own config files into a fake `$HOME` per spawned server, and starts/stops its own `dist/server.js` process on its own port as part of the test run.

## Status

**Verified end-to-end and automated.** `mysql.test.ts` covers tool listing, a plain SELECT, the READ ONLY transaction unconditionally rejecting an INSERT (error 1792, even from a fully-privileged account), the same transaction *not* rejecting a CREATE TABLE and that table actually persisting (the documented DDL gap above), a nonexistent-table error path, and a connection-failure regression — driven over the real Streamable HTTP transport against the sandbox's `mysql` service. Wired into `deploy/opencode.json.example` (`mcp.mysql`, `type: "remote"`, `enabled: true`). The `auditQuery()` hook remains an intentional no-op until a rule-based or LLM-based check is designed for it.
