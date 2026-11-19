# mysql

Read-only SQL for the agent as a command, `opencode-mysql-query`, which reads one statement from stdin, connects straight to MySQL, runs it and prints the rows as CSV. Written in TypeScript (one file, `src/cli.ts`), compiled to `dist/`. There is no server to run. It is the same shape as [`oracle`](../oracle/README.md), whose README has the reasoning (why a command and not an MCP tool, why only a heredoc, why exit 0 or 1).

## Usage

```bash
opencode-mysql-query <<'SQL'
SELECT * FROM employees WHERE dept = 10
SQL

opencode-mysql-query <<'SQL' > /tmp/big.csv
SELECT * FROM big_table
SQL

opencode-mysql-query --help
```

The statement is read from stdin, always, with no arguments and no options: use a heredoc with a quoted delimiter so the shell leaves `$`, backticks (MySQL quotes identifiers with them), quotes and backslashes alone. Every row of the result goes to stdout as CSV, nothing cut off, so cut the output in the SQL (`WHERE`, an aggregate, `LIMIT n`) or in the shell. A database error is printed to stderr exactly as MySQL gave it. Exit codes: `0` ok, `1` anything went wrong (stderr says what).

## Design

- **One connection per run.** Nothing a statement leaves open outlives the run (closing ends its transaction), concurrent runs never share a session.
- **Read-only by two layers.** Every statement runs inside `START TRANSACTION READ ONLY`, which makes MySQL itself refuse `INSERT`, `UPDATE` and `DELETE` (error 1792, checked against a real MySQL 8) whatever the account's grants. **DDL is not covered:** `CREATE`, `DROP` and `ALTER` commit implicitly before running, which takes them outside the transaction. The connecting account's own grants are the real boundary, see below.
- **Plain output.** Dates stay as the text MySQL sent (`2024-01-02 03:04:05`), big integers stay exact, a binary column (BLOB, BINARY) is base64, a JSON column is JSON text, and two columns of the same name both survive.

## Recommended read-only account

Because DDL gets past the transaction, give the connecting account read access only, for example `GRANT SELECT, SHOW VIEW, PROCESS ON *.* TO 'readonly'@'%'` (checked to refuse `CREATE`, `INSERT`, `DROP` and `EXECUTE` whatever the transaction mode).

## Configuration

Read from a file, not environment variables, at a fixed location under `$HOME/.config/kealthas-dev/opencode-mcp-mysql/`: `config.json` by default, or `config-<name>.json` with `MYSQL_CONFIG_ENV=<name>`. Only a short name is taken from the environment, never a path. The file is read on every run, so editing it needs nothing restarted.

```json
{
  "MYSQL_CONNECT_STRING": "mysql://username:password@hostname:3306/database_name"
}
```

The connect string is a URI; its database is the default one, and other databases are written `db.table` in the SQL. **If the password has any of `@ : / ? #` or a space, percent-encode that character first** (a literal `@` becomes `%40`): they are the URI's own delimiters, and an unencoded one is read as part of the host. `config.example.json` shows the shape.

## Installing it

Published as `@kealthas-dev/opencode-mcp-mysql` (the name is part of the config path, so it keeps the `mcp` although there is no MCP any more). `npm install -g @kealthas-dev/opencode-mcp-mysql` puts `opencode-mysql-query` on `PATH`; then write the config file. See SETUP.md step 10.

## Status

`mysql.test.ts` runs against a real MySQL instance in the docker sandbox (see `docker/notes.md`, "MySQL test instance"), running the built command the way an agent would: CSV output and quoting, a 50000-row result coming back whole, `| head` closing the pipe early, duplicate column names, dates/big integers/binary/JSON as text, `$`, backticks and a backslash arriving untouched, `INSERT`/`UPDATE`/`DELETE` refused with nothing changed, a MySQL error passed through untouched, a statement with no result set, usage errors, bad credentials, and a missing or broken config file.

Known, not covered: DDL goes through (see Design).
