# loki mcp server

A minimal MCP server exposing three read-only tools — `loki_query_range`, `loki_labels`, `loki_label_values` — against a configured Grafana Loki instance's HTTP query API. Built directly against `@modelcontextprotocol/sdk`, same hand-rolled-against-the-raw-API pattern as `mcp-servers/oracle/`. Speaks MCP over Streamable HTTP, as a persistent process opencode connects to (`type: "remote"`) rather than spawns and owns (`type: "local"`) — same deployment shape as `mcp-servers/oracle/`.

## Design, and why it looks the way it does

- **Remote, not local**, for the same reason as `mcp-servers/oracle/`: a persistent HTTP server, started independently (`npm start` under a process supervisor — see `deploy/opencode.json.example`/SETUP.md) and reachable at a fixed URL, so its uptime isn't tied to opencode's own restarts.
- **Stateless HTTP, one `Server`/transport pair per request** (`sessionIdGenerator: undefined`, matching the SDK's own reference example and `mcp-servers/oracle/server.js`'s shell). No session state worth keeping between calls.
- **Three tools, not one.** `loki_query_range` is the actual log query (arbitrary LogQL, full passthrough — no filtering, mirroring `oracle_query`'s "safety lives elsewhere" stance, except there's no write side here to guard against in the first place). `loki_labels`/`loki_label_values` exist because LogQL selectors need real label names/values to be useful — without a way to discover them, an agent (or a human) querying unfamiliar logs would have to guess. All three are read-only GETs; adding the two discovery tools costs nothing beyond `oracle_query`'s single-tool baseline.
- **`start`/`end` accept relative and naive-local forms, not just Loki's own RFC3339/epoch.** Handing a caller (model or human) the burden of computing an exact RFC3339 offset or a 19-digit nanosecond epoch by hand is real friction, so `resolveTimeParam()` in `server.js` accepts `"now"`/`"now-1h"`/`"now-30m"`/`"now-1d"` (Grafana's own relative-time syntax for Loki/Prometheus, not invented here) and a bare `"YYYY-MM-DDTHH:MM:SS"`/`"YYYY-MM-DD HH:MM:SS"` with no timezone (assumed to be `LOKI_DEFAULT_TZ_OFFSET`, default `+08:00`), converting either into what Loki actually expects before the request goes out. An already-qualified RFC3339 offset or bare epoch still passes straight through unchanged - purely additive, not a breaking change to the original format.
- **No connection lifecycle, no audit hook.** `mcp-servers/oracle/server.js`'s per-request-connection design and `auditQuery()` extension point both exist because SQL can write. Loki's query API has no write side at all, so there's nothing analogous to design around — each tool call is just a plain `fetch`, wrapped so a non-2xx response or network failure comes back as a clean `{success: false, error}` instead of a thrown error (same shape `executeQuery()` returns in `mcp-servers/oracle/server.js`, same reason: tool results should never surface as a raw MCP protocol error).

## Configuration

Copy `.env.example` to `.env` and fill in real values, or set them however the process supervisor that starts this server (see Run below) is configured. A `remote` MCP entry in `opencode.json` carries no `environment` field (just a `url`) — opencode never starts this process, so wherever it actually gets started is what needs these set:

- `LOKI_BASE_URL` — base URL of the Loki instance, no trailing path (e.g. `http://192.168.1.100:3100`)
- `LOKI_USERNAME` / `LOKI_PASSWORD` — optional, HTTP basic auth, only if this Loki instance requires it
- `LOKI_ORG_ID` — optional, sets `X-Scope-OrgID` for multi-tenant Loki / Grafana Cloud-style setups
- `LOKI_MCP_PORT` — port to listen on (optional, defaults to `8091` — the next free port after `mcp-servers/oracle/`'s `8090`)

Unlike `mcp-servers/oracle/`, only `LOKI_BASE_URL` is required — Loki is commonly reachable unauthenticated on an internal LAN.

## Run

Published as `@kealthas-dev/opencode-mcp-loki` — on a real deployment, install it globally and run the resulting binary (see SETUP.md step 7):

```bash
npm install -g @kealthas-dev/opencode-mcp-loki
LOKI_BASE_URL=... opencode-mcp-loki
```

For local dev/testing against this repo's own checkout (this directory, not the published package):

```bash
npm install
npm start
```

Either way, this starts a persistent HTTP server on `LOKI_MCP_PORT` (default `8091`), serving MCP over Streamable HTTP at `/mcp`. Point opencode at it with a `type: "remote"` entry (see `deploy/opencode.json.example`) — it needs to already be running and stay running, since opencode connects rather than spawns it (either command alone exits when its terminal closes; see `mcp-servers/oracle/README.md`'s Design section for real supervisor options — the same reasoning applies here).

## Testing against a real Loki instance

`docker/docker-compose.loki.yml`'s `loki` service comes up automatically via `docker/dev.sh`, no separate step needed:

```sh
docker/dev.sh run --rm opencode-dev bash
```

`LOKI_BASE_URL` is already set inside that shell — `cd mcp-servers/loki && npm install && npm start`, then hit `http://localhost:8091/mcp` from an MCP client or `curl`.

`loki.test.mjs` (see `tests/README.md`) doesn't need this manual dance — it starts and stops its own `server.js` process on its own port as part of the test run, and seeds its own test log lines by pushing directly to Loki's push API (not through this MCP server, which is read-only by design).

## Status

**Verified end-to-end and automated.** `loki.test.mjs` covers tool listing, `loki_labels`/`loki_label_values` finding pushed test data, `loki_query_range` finding a pushed log line by content, an empty-result query returning cleanly (not an error), and a malformed LogQL query returning a clean error — driven over the real Streamable HTTP transport against the sandbox's `loki` service. Wired into `deploy/opencode.json.example` (`mcp.loki`, `type: "remote"`, `enabled: true`).
