# loki mcp server

A minimal MCP server exposing three read-only tools — `loki_query_range`, `loki_labels`, `loki_label_values` — against a configured Grafana Loki instance's HTTP query API. Written in TypeScript (`src/server.ts` + `src/types/config.ts`, compiled to `dist/` — see Run below), built directly against `@modelcontextprotocol/sdk`, same hand-rolled-against-the-raw-API pattern as `mcp-servers/oracle/`. Speaks MCP over Streamable HTTP, as a persistent process opencode connects to (`type: "remote"`) rather than spawns and owns (`type: "local"`) — same deployment shape as `mcp-servers/oracle/`.

## Design, and why it looks the way it does

- **Remote, not local**, for the same reason as `mcp-servers/oracle/`: a persistent HTTP server, started independently (`npm start` under a process supervisor — see `deploy/opencode.json.example`/SETUP.md) and reachable at a fixed URL, so its uptime isn't tied to opencode's own restarts.
- **Stateless HTTP, one `Server`/transport pair per request** (`sessionIdGenerator: undefined`, matching the SDK's own reference example and `mcp-servers/oracle/src/server.ts`'s shell). No session state worth keeping between calls.
- **Three tools, not one.** `loki_query_range` is the actual log query (arbitrary LogQL, full passthrough — no filtering, mirroring `oracle_query`'s "safety lives elsewhere" stance, except there's no write side here to guard against in the first place). `loki_labels`/`loki_label_values` exist because LogQL selectors need real label names/values to be useful — without a way to discover them, an agent (or a human) querying unfamiliar logs would have to guess. All three are read-only GETs; adding the two discovery tools costs nothing beyond `oracle_query`'s single-tool baseline.
- **`start`/`end` accept relative and naive-local forms, not just Loki's own RFC3339/epoch.** Handing a caller (model or human) the burden of computing an exact RFC3339 offset or a 19-digit nanosecond epoch by hand is real friction, so `resolveTimeParam()` in `src/server.ts` accepts `"now"`/`"now-1h"`/`"now-30m"`/`"now-1d"` (Grafana's own relative-time syntax for Loki/Prometheus, not invented here) and a bare `"YYYY-MM-DDTHH:MM:SS"`/`"YYYY-MM-DD HH:MM:SS"` with no timezone (assumed to be `LOKI_DEFAULT_TZ_OFFSET`, default `+08:00`), converting either into what Loki actually expects before the request goes out. An already-qualified RFC3339 offset or bare epoch still passes straight through unchanged - purely additive, not a breaking change to the original format.
- **No connection lifecycle, no audit hook.** `mcp-servers/oracle/src/server.ts`'s per-request-connection design and `auditQuery()` extension point both exist because SQL can write. Loki's query API has no write side at all, so there's nothing analogous to design around — each tool call is just a plain `fetch`, wrapped so a non-2xx response or network failure comes back as a clean `{success: false, error}` instead of a thrown error (same shape `executeQuery()` returns in `mcp-servers/oracle/src/server.ts`, same reason: tool results should never surface as a raw MCP protocol error).

## Configuration

Config is file-based, not env-var-based — same two-file split as `mcp-servers/oracle/` (see its README's Configuration section for the fullest writeup of the pattern). The config file's *location* is never user-supplied, only a short name is; see that same section for why.

- **`$HOME/.config/kealthas-dev/opencode-mcp-loki/server.json`** — the port to listen on. `LOKI_MCP_PORT` env var overrides it, for running more than one instance. Otherwise optional: if missing, defaults to `8091`; if present, must be valid JSON or the server refuses to start. Shape (see `server.example.json`):
  ```json
  { "LOKI_MCP_PORT": 8091 }
  ```
- **A Loki config file, re-read on every tool call (no restart needed after editing it).** With no `LOKI_CONFIG_ENV` set, it's read from `$HOME/.config/kealthas-dev/opencode-mcp-loki/config.json`. For multiple environments, set `LOKI_CONFIG_ENV` to a name and it reads `config-<name>.json` instead — e.g. `LOKI_CONFIG_ENV=prod` reads `config-prod.json`. The server prints a sample and exits if the resolved file doesn't exist or `LOKI_BASE_URL` is missing from it. Shape (see `config.example.json`):
  ```json
  {
    "LOKI_BASE_URL": "http://192.168.1.100:3100",
    "LOKI_USERNAME": "username",
    "LOKI_PASSWORD": "password",
    "LOKI_ORG_ID": "tenant-id",
    "LOKI_DEFAULT_TZ_OFFSET": "+08:00"
  }
  ```
  Only `LOKI_BASE_URL` (no trailing path, e.g. `http://192.168.1.100:3100`) is required — Loki is commonly reachable unauthenticated on an internal LAN, unlike `mcp-servers/oracle/`. `LOKI_USERNAME`/`LOKI_PASSWORD` are HTTP basic auth; `LOKI_ORG_ID` sets `X-Scope-OrgID` for multi-tenant Loki / Grafana Cloud-style setups; `LOKI_DEFAULT_TZ_OFFSET` defaults to `+08:00` if omitted.

  **When Loki has no directly reachable port of its own** — a common setup where Grafana is the only thing exposed and Loki sits behind it — set `LOKI_VIA_GRAFANA: true` and `LOKI_BASE_URL` becomes Grafana's own URL instead of Loki's. Every request routes through Grafana's datasource-proxy endpoint (`/api/datasources/proxy/<id>/loki/api/v1/...`) rather than hitting a Loki API root directly. `LOKI_USERNAME`/`LOKI_PASSWORD` still work unchanged in this mode — Basic Auth against a real Grafana user account, not Loki itself (Grafana's own default is `admin`/`admin` until changed). `LOKI_GRAFANA_DATASOURCE_ID` is the Loki datasource's ID as assigned inside that Grafana instance (visible in its Data Sources page URL) — optional, defaults to `"1"`, which is what a single-datasource Grafana instance almost always has:
  ```json
  {
    "LOKI_BASE_URL": "http://192.168.1.100:3100",
    "LOKI_USERNAME": "admin",
    "LOKI_PASSWORD": "admin",
    "LOKI_VIA_GRAFANA": true,
    "LOKI_GRAFANA_DATASOURCE_ID": "1"
  }
  ```
  A telltale sign you need this mode: querying with `LOKI_VIA_GRAFANA` unset returns an HTML page (often a 404) instead of a JSON error — real Loki's own error responses are always plain text/JSON, never HTML, so an HTML response means the request landed on Grafana's own web UI instead of Loki's API.

## Run

Published as `@kealthas-dev/opencode-mcp-loki` — on a real deployment, install it globally and run the resulting binary (see SETUP.md step 7):

```bash
npm install -g @kealthas-dev/opencode-mcp-loki
mkdir -p ~/.config/kealthas-dev/opencode-mcp-loki
# real config at ~/.config/kealthas-dev/opencode-mcp-loki/config-prod.json (see config.example.json for the shape)
LOKI_CONFIG_ENV=prod opencode-mcp-loki
```

For local dev/testing against this repo's own checkout (this directory, not the published package), same idea — drop a real config file at the default location, or a named `config-<name>.json` (see `config.example.json` for the shape — the sandbox's docker-entrypoint.sh generates the default one automatically, see Testing below):

```bash
npm install
npm run build
npm start   # reads ~/.config/kealthas-dev/opencode-mcp-loki/config.json
```

`npm run dev` runs `src/server.ts` directly via `tsx watch` instead, for a compile-on-save loop.

Either way, this starts a persistent HTTP server on the configured port (default `8091`), serving MCP over Streamable HTTP at `/mcp`. Point opencode at it with a `type: "remote"` entry (see `deploy/opencode.json.example`) — it needs to already be running and stay running, since opencode connects rather than spawns it (either command alone exits when its terminal closes; see `mcp-servers/oracle/README.md`'s Design section for real supervisor options — the same reasoning applies here).

## Testing against a real Loki instance

`docker/docker-compose.loki.yml`'s `loki` service is a shared fixture started separately, not by `docker/dev.sh`:

```sh
docker compose -f docker/docker-compose.loki.yml up -d
docker/dev.sh run --rm opencode-dev bash
```

The default config file is already in place inside that shell — `docker-entrypoint.sh` generates `~/.config/kealthas-dev/opencode-mcp-loki/config.json` from the sandbox's `LOKI_BASE_URL` compose env var. `cd mcp-servers/loki && npm install && npm run build && npm start`, then hit `http://localhost:8091/mcp` from an MCP client or `curl`.

`loki.test.ts` (see `tests/README.md`) doesn't need this manual dance — it builds its own config files into a fake `$HOME` per spawned server (same pattern as `mcp-servers/oracle/oracle.test.ts`) and starts/stops its own `dist/server.js` process on its own port as part of the test run, seeding its own test log lines by pushing directly to Loki's push API (not through this MCP server, which is read-only by design).

## Status

**Direct-to-Loki path verified end-to-end and automated.** `loki.test.ts` covers tool listing, `loki_labels`/`loki_label_values` finding pushed test data, `loki_query_range` finding a pushed log line by content, an empty-result query returning cleanly (not an error), and a malformed LogQL query returning a clean error — driven over the real Streamable HTTP transport against the sandbox's `loki` service. Wired into `deploy/opencode.json.example` (`mcp.loki`, `type: "remote"`, `enabled: true`).

**`LOKI_VIA_GRAFANA` verified only against a fake stand-in HTTP server** (confirms the request lands on `/api/datasources/proxy/<id>/...` with the right Basic Auth header) — not against a real Grafana instance, and not covered by `loki.test.ts`. See `mcp-servers/TODO.md` for adding a real Grafana fixture to the sandbox.
