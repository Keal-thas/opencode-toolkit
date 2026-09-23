# oracle mcp server

Lives in `mcp-servers/oracle/`. An MCP server exposing one tool, `oracle_query`, running arbitrary SQL against a configured Oracle database — full passthrough, one connection per request, `autoCommit: true`, a no-op `auditQuery()` extension point for a future safety layer. Design rationale lives in `mcp-servers/oracle/README.md`'s "Design" section (canonical, not duplicated here). Runs as a `type: "remote"`/Streamable HTTP server: opencode connects to an independently-started process rather than spawning it.

**Tested:** `mcp-servers/oracle/oracle.test.ts` (see `tests/README.md`) — tool listing, a plain SELECT, a write surviving the per-request connection close (autoCommit), a nonexistent-table error path, and a connection-failure regression (an earlier bug crashed the MCP protocol instead of returning a clean error). Runs as part of `./tests/run-all.sh` against the sandbox's real `oracle` service.
