# loki mcp server

Lives in `mcp-servers/loki/`. An MCP server exposing three read-only tools — `loki_query_range` (arbitrary LogQL over a time range), `loki_labels` (list label names), `loki_label_values` (list values for a label) — against a configured Grafana Loki instance's HTTP query API. No driver dependency, just `fetch` against Loki's stable HTTP API. Design rationale lives in `mcp-servers/loki/README.md`'s "Design" section (canonical, not duplicated here). Runs as a `type: "remote"`/Streamable HTTP server, same deployment shape as `mcp-servers/oracle/`.

**Tested:** `mcp-servers/loki/loki.test.mjs` (see `tests/README.md`) — tool listing, label/label-value discovery finding a pushed test stream, a range query finding a pushed log line by content, an empty-result query returning cleanly, and malformed LogQL returning a clean error. Runs as part of `./tests/run-all.sh` against the sandbox's real `loki` service.
