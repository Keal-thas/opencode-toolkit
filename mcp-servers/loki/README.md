# loki

Loki log queries for the agent as a command, `opencode-loki-query`, which reads a LogQL query from stdin, asks Loki (or Grafana's datasource proxy for it) and prints the result. Written in TypeScript (one file, `src/cli.ts`, no dependencies), compiled to `dist/`. There is no server to run. It is the same shape as [`oracle`](../oracle/README.md), whose README has the reasoning (why a command and not an MCP tool, why only a heredoc, why exit 0 or 1).

## Usage

```bash
opencode-loki-query --since 1h <<'LOGQL'
{app="api"} |= "error"
LOGQL

opencode-loki-query --start 2026-09-15T10:00:00+08:00 --end 2026-09-15T10:30:00+08:00 --limit 500 <<'LOGQL'
{app="api"}
LOGQL

opencode-loki-query --labels --since 24h
opencode-loki-query --values app --since 24h
opencode-loki-query --help
```

The query is read from stdin, always: use a heredoc with a quoted delimiter so the shell leaves the quotes, backticks, `$` and backslashes of LogQL alone. The options are Loki's own query parameters, passed through unchanged, so Loki's own rules and defaults apply (a recent window, 100 lines, newest first):

| Option | Loki parameter |
|---|---|
| `--since 1h` | `since`: how far back from now |
| `--start`, `--end` | `start`, `end`: RFC3339 with an offset (`2026-09-15T10:00:00+08:00`) or a unix timestamp |
| `--limit N` | `limit`: most log lines to return |
| `--labels` | the label names, instead of a query |
| `--values LABEL` | the values of one label, instead of a query |

A query prints **one line of JSON per stream**, `{"stream":{...labels},"values":[["<ns timestamp>","<log line>"],...]}`; `--labels` and `--values` print one name or value per line. Only the result is printed, not Loki's envelope or its statistics block. An error from Loki is printed to stderr exactly as Loki gave it. Exit codes: `0` ok, `1` anything went wrong (stderr says what).

## Configuration

Read from a file, not environment variables, at a fixed location under `$HOME/.config/kealthas-dev/opencode-mcp-loki/`: `config.json` by default, or `config-<name>.json` with `LOKI_CONFIG_ENV=<name>`. Only a short name is taken from the environment, never a path. The file is read on every run, so editing it needs nothing restarted.

```json
{
  "LOKI_BASE_URL": "http://192.168.1.100:3100",
  "LOKI_USERNAME": "username",
  "LOKI_PASSWORD": "password",
  "LOKI_ORG_ID": "tenant-id",
  "LOKI_VIA_GRAFANA": false,
  "LOKI_GRAFANA_DATASOURCE_ID": "1"
}
```

Only `LOKI_BASE_URL` (no trailing path) is required: Loki is commonly reachable without authentication on an internal LAN. `LOKI_USERNAME`/`LOKI_PASSWORD` are HTTP Basic auth and `LOKI_ORG_ID` the `X-Scope-OrgID` tenant header, each only if that instance needs it.

**If Loki has no directly reachable port and the only way in is Grafana's datasource proxy:** set `LOKI_BASE_URL` to Grafana's own URL, `LOKI_VIA_GRAFANA` to `true`, `LOKI_GRAFANA_DATASOURCE_ID` to the datasource's id (the number in `/connections/datasources/edit/...`'s API listing, `GET /api/datasources`; default `1`), and `LOKI_USERNAME`/`LOKI_PASSWORD` to a real Grafana user's Basic auth, not a Loki credential. Requests then go to `/api/datasources/proxy/<id>/loki/api/v1/...`. A Grafana that rejects the request answers with a redirect to its login page, not a 401; the command reports that redirect and what to check instead of following it. `config.example.json` shows the shape.

## Installing it

Published as `@kealthas-dev/opencode-mcp-loki` (the name is part of the config path, so it keeps the `mcp` although there is no MCP any more). `npm install -g @kealthas-dev/opencode-mcp-loki` puts `opencode-loki-query` on `PATH`; then write the config file. See SETUP.md step 7.

## Status

`loki.test.ts` runs against a real Loki instance in the docker sandbox (see `docker/notes.md`, "Loki test instance"), seeding lines through Loki's push API and running the built command the way an agent would: a query's streams and log lines, `--since`, `--start`/`--end` and `--limit`, a query with `$`, backticks and a backslash arriving untouched, `--labels` and `--values`, a malformed query's error passed through, a query matching nothing, usage errors, an unreachable Loki, and a missing or broken config file. The Grafana path (`LOKI_VIA_GRAFANA`, Basic auth, the org header, a redirect, an error body) is checked against a throwaway HTTP server standing in for Grafana, not against a real Grafana.
