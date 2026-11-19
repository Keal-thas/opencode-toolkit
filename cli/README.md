# cli

One directory per command the agent runs with `bash` to reach a database or log store. Each connects straight to its backend, with no server of its own and no MCP tool; each README has that command's usage, design and setup. The reason these are commands and not MCP servers is in [docs/design-philosophy.md](../docs/design-philosophy.md).

This table is the one list of commands; other docs link here instead of repeating it.

| Command | What it does | Backend |
|---|---|---|
| [`oracle`](oracle/README.md) | `opencode-oracle-query`: SQL on stdin, read-only, CSV out | Oracle |
| [`loki`](loki/README.md) | `opencode-loki-query`: LogQL on stdin, Loki's own time options | Loki, or Grafana's datasource proxy |
| [`mysql`](mysql/README.md) | `opencode-mysql-query`: SQL on stdin, read-only, CSV out | MySQL |
| [`redis`](redis/README.md) | `opencode-redis-query`: one Redis command on stdin, reply one value per line | Redis |

Every command is published to npm as `@kealthas-dev/opencode-<name>-query` ([docs/npm-publishing.md](../docs/npm-publishing.md)) and reads its connection settings from `~/.config/kealthas-dev/opencode-<name>-query/config.json`. The shared interface (the query on stdin in a heredoc, no arguments, the result and the backend's own errors printed untouched, exit 0 or 1) is described in [oracle/README.md](oracle/README.md).
