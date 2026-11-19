# oracle

Read-only SQL for the agent as a command, `opencode-oracle-query`, which reads one statement from stdin, connects straight to Oracle, runs it and prints the rows as CSV. Written in TypeScript (one file, `src/cli.ts`), compiled to `dist/`. There is no server to run.

It is a command, not an MCP tool, because an MCP tool result goes into the model's context whole: the agent cannot `head`, `grep` or `awk` it first. A command's stdout can be cut, piped or redirected to a file.

## Usage

```bash
opencode-oracle-query <<'SQL'
SELECT * FROM employees WHERE dept = 10
SQL

opencode-oracle-query <<'SQL' > /tmp/big.csv
SELECT * FROM big_table
SQL

opencode-oracle-query <<'SQL' | head -n 20
SELECT * FROM big_table
SQL

opencode-oracle-query < query.sql
opencode-oracle-query --help
```

The statement is read from stdin, always. There is no argument form on purpose: SQL is full of single quotes and sometimes `$`, so quoting it as an argument is a way to get it wrong (inside double quotes the shell expands `$`, so `v$session` would reach Oracle as `v`). With a quoted heredoc delimiter (`<<'SQL'`) the shell touches nothing.

That is the whole interface: one SQL statement on stdin, every row of the result on stdout as CSV, no arguments, no options. Nothing is cut off, so cut the output in the SQL (a `WHERE` clause, an aggregate, `FETCH FIRST n ROWS ONLY`) or in the shell. A database error is printed to stderr exactly as the database gave it, nothing added.

Exit codes: `0` ok, `1` anything went wrong (the SQL, the connection, the config, a usage error); stderr says what.

## Design

- **One connection per run.** Nothing a statement leaves open outlives the run (closing rolls back), concurrent runs never share a session, and a session dropped on the database side fails only that run.
- **Read-only by two layers.** Every query runs after `SET TRANSACTION READ ONLY`, so Oracle itself refuses `INSERT`, `UPDATE` and `DELETE` (`ORA-01456`) even for an account that holds write grants. **DDL is not covered:** it commits first and then runs, so `CREATE TABLE` or `DROP TABLE` goes through. The connecting account's own grants are the real boundary, see below.
- **Plain output.** CLOB and NCLOB come back as text, BLOB as base64, RAW as hex, DATE and TIMESTAMP as `YYYY-MM-DD HH24:MI:SS` text (a TIMESTAMP keeps milliseconds, nothing finer; time-zone types become an ISO instant). A trailing `;` on a `SELECT` is dropped, since Oracle rejects it. The session's date format is set to match the output, so a date literal in the SQL converts the way the output prints. A join with two columns of the same name keeps both (the driver renames the second to `ID_1`).
- **A table changed a moment ago cannot be read for a few seconds.** A read-only transaction takes a snapshot, and Oracle answers `ORA-01466` for a table whose definition changed within about the last few seconds. It passes by itself.

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

The connection settings are read from a file, not environment variables, at a fixed location under `$HOME/.config/kealthas-dev/opencode-mcp-oracle/`: `config.json` by default, or `config-<name>.json` with `ORACLE_CONFIG_ENV=<name>`. Only a short name is taken from the environment, never a path, so a shell that did not expand `~` cannot point the command at a wrong location. The file is read on every run, so editing it needs nothing restarted.

```json
{
  "ORACLE_CONNECT_STRING": "hostname:1521/service_name",
  "ORACLE_USER": "username",
  "ORACLE_PASSWORD": "password",
  "ORACLE_DEFAULT_SCHEMA": "SCHEMA_NAME"
}
```

`ORACLE_CONNECT_STRING` is an Easy Connect string (`host:port/service_name`) or a full TNS descriptor. `ORACLE_DEFAULT_SCHEMA` is optional (exact case as Oracle stores it, normally uppercase): it sets the session's current schema, so the SQL can leave the schema prefix off. A missing or broken file makes the run fail with the path and the expected shape in the message. `config.example.json` shows the shape.

```text
~/.config/kealthas-dev/opencode-mcp-oracle/
├── config.json          # used when ORACLE_CONFIG_ENV is unset
├── config-prod.json     # ORACLE_CONFIG_ENV=prod
└── config-dev.json      # ORACLE_CONFIG_ENV=dev
```

## Installing it

Published as `@kealthas-dev/opencode-mcp-oracle` (the name is part of the config path, so it keeps the `mcp` in it although there is no MCP any more). Install it globally, which puts `opencode-oracle-query` on `PATH`, and write the config file. See SETUP.md step 6.

```bash
npm install -g @kealthas-dev/opencode-mcp-oracle
echo 'SELECT 1 FROM dual' | ORACLE_CONFIG_ENV=prod opencode-oracle-query     # reads config-prod.json
```

For the repo's own checkout, `npm install && npm run build` in this directory, then `node dist/cli.js < query.sql`.

## Status

`oracle.test.ts` runs against a real Oracle instance in the docker sandbox (see `docker/notes.md`, "Oracle test instance"), running the built command the way an agent would: CSV output and quoting, a trailing semicolon, `$`, quotes and a backslash arriving untouched, a `V$` view through a quoted heredoc, an argument refused, a 50000-row result coming back whole, `| head` closing the pipe early, duplicate column names, dates/CLOB/BLOB/RAW as text, `ORACLE_DEFAULT_SCHEMA`, `INSERT`/`UPDATE`/`DELETE` refused with nothing changed, an Oracle error passed through untouched, usage errors, bad credentials, and a missing or broken config file.

Known, not covered: DDL goes through (see Design), and a TIMESTAMP loses anything finer than milliseconds.
