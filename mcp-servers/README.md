# mcp-servers

One directory per MCP server. Each README has that server's setup and design; `TODO.md` is the backlog.

This table is the one list of servers; other docs link here instead of repeating it.

| Server | What it does | Code | Transport | In `deploy/opencode.jsonc.example` |
|---|---|---|---|---|
| [`oracle`](oracle/README.md) | `opencode-oracle-query "<sql>"` command, read-only SQL through a local query server | ours | CLI | not wired |
| [`loki`](loki/README.md) | read-only LogQL queries | ours | remote | enabled |
| [`mysql`](mysql/README.md) | `mysql_query` inside a read-only transaction | ours | remote | enabled |
| [`java-lsp`](java-lsp/README.md) | Java code intelligence via jdtls | ours | remote | enabled |
| [`spring-lsp`](spring-lsp/README.md) | Spring-aware code intelligence | ours | remote | enabled |
| [`memory`](memory/README.md) | cross-session knowledge graph | upstream package | local | enabled |
| [`redis`](redis/README.md) | read-only Redis via an ACL user | upstream package | local | enabled |
| [`playwright`](playwright/README.md) | browser automation | upstream package | local | not wired |

The `idea` entry in the example config (IntelliJ's built-in MCP server, disabled until a URL is filled in) has no directory here; see `TODO.md` at the repo root.

"Remote" servers are started separately and opencode connects to a URL; "local" ones are spawned by opencode; "CLI" ones have no MCP tool at all: the agent runs a command with `bash`, and the command talks to a query server started separately. `oracle` is the first of that kind, and its package keeps the `opencode-mcp-` name because the name is part of the config path. Every server we wrote is published to npm as `@kealthas-dev/opencode-mcp-<name>` ([docs/npm-publishing.md](../docs/npm-publishing.md)).
