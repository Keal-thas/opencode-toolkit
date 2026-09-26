# redis mcp server

Unlike `mcp-servers/oracle/`, `mcp-servers/loki/`, and `mcp-servers/mysql/`, there's no server code in this directory — this is the official upstream [`redis/mcp-redis`](https://github.com/redis/mcp-redis) package (PyPI `redis-mcp-server`), used unmodified, same "sight-unseen from its own README" stance as the Memory MCP server (see `docs/feature-points/15-opencode-memory-mcp.md`). This directory just holds the deployment notes.

## Why the official package, not a hand-rolled one like mysql

`mcp-servers/mysql/` and `mcp-servers/oracle/` are hand-written because the problem there is small and generic: one passthrough SQL tool, with a read-only guarantee that has to be bolted on ourselves (a `START TRANSACTION READ ONLY` wrapper for MySQL, DB grants for Oracle) since SQL has no native per-statement read/write tagging — see `mcp-servers/mysql/README.md`'s documented DDL gap for exactly how fiddly that gets. Redis doesn't have that problem: every command already carries a `@read`/`@write` ACL category natively (confirmed against a real Redis 7 instance — see `docker/docker-notes.md`'s "Redis test instance" section: a `+@read -@write` user gets `NOPERM` on `SET`/`DEL`/`FLUSHALL`, and on `EVAL` and `SORT ... STORE` too, since Redis categorizes anything with a possible write side effect as `@write` outright, no MySQL-style DDL loophole). The official package's own tool surface (string/hash/list/set/sorted-set/stream/pub-sub/JSON tools — see its README) would also be a lot to hand-roll and re-verify for no benefit, when the read-only guarantee is enforced one layer down regardless of which tools call into it.

## Read-only enforcement: a dedicated ACL user, not code

The package's own README documents this directly (see its "Redis ACL" section) — there's no config flag or connection setting on the package itself that trims it to a read-only tool set; the safety boundary is the account it connects as:

```
127.0.0.1:6379> ACL SETUSER readonlyuser on >mypassword ~* +@read -@write
```

Confirmed end-to-end against a real Redis 7 instance (this repo's own `docker/docker-compose.redis.yml` sandbox, see `docker/redis.conf`): this exact ruleset lets `GET`/`KEYS` through and denies `SET`/`DEL`/`FLUSHALL`/`EVAL`/`SORT ... STORE` with `NOPERM`, regardless of what tool or query text asked for it.

## Wired as `type: "local"`, not `type: "remote"`

Unlike `oracle`/`loki`/`mysql` (persistent HTTP servers opencode connects to), `redis-mcp-server` only supports stdio transport today — its own README: "Support to the streamable-http transport will be added in the future." So opencode spawns and owns this one directly, same shape as the Memory MCP server:

```json
"mcp": {
  "redis": {
    "type": "local",
    "command": ["uvx", "--from", "redis-mcp-server@latest", "redis-mcp-server", "--host", "...", "--port", "..."],
    "enabled": true,
    "environment": {
      "REDIS_USERNAME": "readonlyuser",
      "REDIS_PWD": "..."
    }
  }
}
```

**`--host`/`--port` have to be CLI args, not `REDIS_HOST`/`REDIS_PORT` env vars — confirmed a real bug in the installed package (`redis-mcp-server`, version resolved via `@latest` at the time of writing), not a style choice.** Its `src/common/config.py` correctly seeds `REDIS_CFG` from `REDIS_HOST`/`REDIS_PORT`/`REDIS_DB`/`REDIS_SSL`/`REDIS_CLUSTER_MODE` env vars at import time — but `src/main.py`'s `cli()` then unconditionally rebuilds `{"host": host, "port": port, "db": db, "ssl": ssl, "cluster_mode": cluster_mode}` from Click's own option values (which default to `"127.0.0.1"`/`6379`/etc. whether or not the user passed `--host`/`--port` — none of those five Click options declare `envvar=`, so Click has no idea the env vars exist) and passes it to `set_redis_config_from_cli()`, which **overwrites** the correctly-seeded env-derived config every single run. `username`/`password` (and every SSL path option) escape this because `main.py` only adds them to that dict `if username:`/`if password:` — Click leaves them `None` when not passed, so the falsy check skips them and the env-derived `REDIS_USERNAME`/`REDIS_PWD` survive untouched. Reproduced against the real sandbox: pure env vars connected to `127.0.0.1:6379` (`Connection refused`, since nothing listens there) instead of the intended `redis:6379`; `--host`/`--port` as CLI args plus `REDIS_USERNAME`/`REDIS_PWD` as env vars connected correctly and authenticated as `readonlyuser`. Host/port aren't secret, so putting them in argv costs nothing; credentials still go through `environment`, not `--username`/`--password`/`--url` args — an argv-based secret shows up in `ps` output for anyone else on the machine, an `environment` entry doesn't. (`--url redis://user:pass@host:port/db` is the package's other documented shortcut and does still read correctly — `parse_redis_uri()`'s branch doesn't have this bug — but it means embedding the password in one URI, which needs percent-encoding for any reserved character (`@ : / ? #`, space) — same gotcha as `mcp-servers/mysql/README.md`'s Configuration section covers for MySQL's connect string, on top of putting the password in argv. Discrete flags avoid both problems.)

Needs `uv`/`uvx` on the target machine — a real prerequisite this deployment doesn't otherwise have (see SETUP.md's step for it and `docker/docker-notes.md`'s "uv/uvx" section for how the sandbox gets it).

## Status

**Verified end-to-end.** `tests/integration/mcp-redis/redis.test.mjs` spawns the real `redis-mcp-server` package via `uvx` against the sandbox's real `redis` service, connected as the ACL-restricted `readonlyuser`: tool listing, a `set`/`get` round-trip through the tools that exist for it, and a write-shaped tool call coming back as a clean Redis `NOPERM` error rather than a crash. Wired into `deploy/opencode.json.example` (`mcp.redis`, `type: "local"`, `enabled: true`).
