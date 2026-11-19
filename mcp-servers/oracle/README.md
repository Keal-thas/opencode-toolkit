# oracle

Read-only SQL for the agent as a command, `opencode-oracle-query "<sql>"`, backed by a small local HTTP query server. Written in TypeScript (`src/server.ts`, `src/cli.ts`), compiled to `dist/`.

It is a command, not an MCP tool, because an MCP tool result goes into the model's context whole: the agent cannot `head`, `grep` or `awk` it first, and a broad `SELECT` costs all of its rows. The command's stdout can be cut, piped or written to a file.

## Design

- **Two parts.** `dist/server.js` is a persistent HTTP server with one route, `POST /query`; `dist/cli.js` is the `opencode-oracle-query` command that calls it. The server holds the credentials, the config and the Oracle connection logic; the command only formats. Started independently and left running (`npm start`, a process supervisor or a container), so its uptime is not tied to opencode's restarts.
- **Per-request connection, not pooled.** A stray statement cannot outlive its request (closing rolls back), concurrent calls never share a session, and a session dropped on the database side fails only that call. The price is connection-setup latency per call, fine for low-QPS internal use.
- **Read-only by two layers.** Every query runs after `SET TRANSACTION READ ONLY`, so Oracle itself refuses `INSERT`, `UPDATE` and `DELETE` (`ORA-01456`) even for an account that holds write grants. **DDL is not covered:** it commits first and then runs, so `CREATE TABLE` or `DROP TABLE` goes through. The connecting account's own grants are the real boundary, see below.
- **Capped output.** The command prints 100 rows by default, `--limit N` or `--all` raises that, and the server refuses to return more than `ORACLE_MAX_ROWS` (default 10000) whatever is asked. A notice on stderr says when rows were left out.
- **Plain output.** CLOB and NCLOB come back as text, BLOB as base64, RAW as hex, DATE and TIMESTAMP as `YYYY-MM-DD HH24:MI:SS` text (a TIMESTAMP keeps milliseconds, nothing finer; time-zone types become an ISO instant). A trailing `;` on a `SELECT` is dropped, since the server rejects it. A join with two columns of the same name keeps both (the driver renames the second to `ID_1`).
- **A table changed a moment ago cannot be read for a few seconds.** A read-only transaction takes a snapshot, and Oracle answers `ORA-01466` for a table whose definition changed within about the last few seconds. It passes by itself.
- **No keyword filtering.** `auditQuery()` in `src/server.ts` is a no-op extension point for a rule-based or LLM-based check later (mirroring `plugins/llm-review-gate/llm-review-gate.ts`).

## Usage

```bash
opencode-oracle-query "SELECT * FROM employees WHERE dept = 10"          # CSV, first 100 rows
opencode-oracle-query "SELECT ..." --json                                 # one JSON object per row
opencode-oracle-query "SELECT ..." --format tsv --limit 20
opencode-oracle-query "SELECT ..." --out /tmp/result.csv                  # whole result to a file, a summary on stdout
opencode-oracle-query "SELECT ..." --schema HR                            # ALTER SESSION SET CURRENT_SCHEMA
opencode-oracle-query --help
```

Exit codes: `0` ok, `1` the SQL failed, `2` usage error, `3` the query could not run (server unreachable, bad credentials or config, timeout).

## Recommended read-only account

The transaction guard does not stop DDL, so the account `ORACLE_USER` points at is the actual safety boundary. Give it read access only, for example:

```sql
CREATE USER readonly IDENTIFIED BY "<a real password>";

GRANT CREATE SESSION, READ ANY TABLE, SELECT ANY SEQUENCE,
      SELECT ANY DICTIONARY, SELECT_CATALOG_ROLE, EXECUTE_CATALOG_ROLE
TO readonly;
```

- `SELECT ANY DICTIONARY` does **not** expose `SYS.USER$` (password hashes) or other similarly hardened SYS tables: Oracle hardcodes that protection regardless of grants.
- `EXECUTE_CATALOG_ROLE` is broader than its name suggests: it grants `EXECUTE` on 115 SYS packages, not just `DBMS_METADATA`, including `DBMS_LOCK`, `DBMS_FILE_TRANSFER`, `DBMS_REDEFINITION` and `DBMS_RLS`. It is there for DDL extraction through `DBMS_METADATA`; drop it if you do not need that.

## Configuration

Config is read from files, not environment variables, and the files' location is fixed under `$HOME/.config/kealthas-dev/opencode-mcp-oracle/`:

- **`server.json`**, the port: `{ "ORACLE_MCP_PORT": 8090 }`. The `ORACLE_MCP_PORT` environment variable overrides it, for running more than one instance. Optional, the default is `8090`. The server and the command both read it, so they find each other.
- **A database config file, re-read on every query** (no restart after editing it): `config.json` by default, or `config-<name>.json` with `ORACLE_CONFIG_ENV=<name>`. Only a short name is taken from the environment, never a path, so a shell that did not expand `~` cannot point the server at a wrong location.

  ```json
  {
    "ORACLE_CONNECT_STRING": "hostname:1521/service_name",
    "ORACLE_USER": "username",
    "ORACLE_PASSWORD": "password",
    "ORACLE_DEFAULT_SCHEMA": "SCHEMA_NAME",
    "ORACLE_MAX_ROWS": 10000
  }
  ```

  `ORACLE_CONNECT_STRING` is an Easy Connect string (`host:port/service_name`) or a full TNS descriptor. `ORACLE_DEFAULT_SCHEMA` (optional, exact case as Oracle stores it, normally uppercase) sets the session's default schema; `--schema` overrides it per call. `ORACLE_MAX_ROWS` (optional) is the hard cap. A missing or broken file fails that one query with the path and the expected shape in the message; the server stays up.

```text
~/.config/kealthas-dev/opencode-mcp-oracle/
├── server.json          # port, one per machine
├── config.json          # used when ORACLE_CONFIG_ENV is unset
├── config-prod.json     # ORACLE_CONFIG_ENV=prod
└── config-dev.json      # ORACLE_CONFIG_ENV=dev
```

`config.example.json` and `server.example.json` show the shapes.

## Running it

Published as `@kealthas-dev/opencode-mcp-oracle`. Install it globally, which puts two commands on `PATH`: `opencode-oracle-query` (the client the agent runs) and `opencode-mcp-oracle` (the server, which stays running). See SETUP.md step 6.

```bash
npm install -g @kealthas-dev/opencode-mcp-oracle
ORACLE_CONFIG_ENV=prod opencode-mcp-oracle     # reads config-prod.json; leave it running
```

For the repo's own checkout, `npm install && npm run build && npm start` in this directory does the same with the default `config.json`. The `opencode-oracle-query` command must run with the same `ORACLE_CONFIG_ENV`/`ORACLE_MCP_PORT` as the server it should reach, or find the same `server.json`.

## Status

`oracle.test.ts` runs against a real Oracle instance in the docker sandbox (see `docker/notes.md`, "Oracle test instance"), through the `opencode-oracle-query` command: CSV, TSV and JSON output, CSV quoting, the 100-row default and `--limit`/`--all`/`--out`, the server-side cap, duplicate column names, dates, CLOB, BLOB and RAW, `INSERT`/`UPDATE`/`DELETE` refused with nothing changed, an Oracle error, usage errors, bad credentials, no server running, and a broken config file that fails one query without taking the server down.

Known, not covered: DDL goes through (see Design), and a TIMESTAMP loses anything finer than milliseconds.
