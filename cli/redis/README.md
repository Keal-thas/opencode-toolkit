# redis

Redis for the agent as a command, `opencode-redis-query`, which reads one Redis command from stdin, connects straight to Redis, runs it and prints the reply. Written in TypeScript (one file, `src/cli.ts`, with the npm `redis` client), compiled to `dist/`. There is no server to run and no Python: an earlier version used the official `redis-mcp-server` PyPI package, which needed `uv`, only spoke stdio and ignored `REDIS_HOST`/`REDIS_PORT`. It is the same shape as [`oracle`](../oracle/README.md), whose README has the reasoning (why a command and not an MCP tool, why only a heredoc, why exit 0 or 1).

## Usage

```bash
opencode-redis-query <<'REDIS'
GET user:42:name
REDIS

opencode-redis-query <<'REDIS'
HGETALL "user:42"
REDIS

opencode-redis-query <<'REDIS' | head -n 20
SCAN 0 MATCH session:* COUNT 1000
REDIS

opencode-redis-query --help
```

The command is read from stdin, always, with no arguments and no options: use a heredoc with a quoted delimiter so the shell leaves quotes, `$`, backticks and backslashes alone. It is written as in `redis-cli`: words separated by spaces, `"double quotes"` (with `\n`, `\xHH` and `\"` escapes) or `'single quotes'` around a word that contains spaces.

The reply is printed the way `redis-cli --raw` prints it, one value per line: a string or number as it is, a missing value as an empty line, an array one element per line (nested arrays flattened, so `HGETALL` is field, value, field, value, and `SCAN` is the cursor and then the keys). An error from Redis is printed to stderr exactly as Redis gave it. Exit codes: `0` ok, `1` anything went wrong (stderr says what). A command that waits for data (`BLPOP key 0`, `SUBSCRIBE`) gives up after 30 seconds.

## Read-only: a dedicated ACL account, not code

Nothing is blocked in this command. What it may do is decided by the Redis account in the config, and Redis already tags every command `@read` or `@write`, with no SQL-style loophole, so a read-only account is one line:

```
ACL SETUSER readonlyuser on >mypassword ~* +@read -@write
```

Checked against a real Redis 7: this lets `GET`, `KEYS`, `SCAN`, `HGETALL` through and refuses `SET`, `DEL`, `FLUSHALL` and `EVAL` with `NOPERM`. It also refuses `INFO`, `PING` and `CLIENT`, which are not in `@read`; add `+info +ping` to the rule if you want them. If the keys follow a prefix convention, `~app:*` instead of `~*` limits the account to those keys. Redis has no schema; the closest thing is the numbered database (`REDIS_DB`), and an ACL cannot limit an account to one database number as far as I know.

## Configuration

Read from a file, not environment variables, at a fixed location under `$HOME/.config/kealthas-dev/opencode-redis-query/`: `config.json` by default, or `config-<name>.json` with `REDIS_CONFIG_ENV=<name>`. Only a short name is taken from the environment, never a path. The file is read on every run, so editing it needs nothing restarted.

```json
{
  "REDIS_HOST": "hostname",
  "REDIS_PORT": 6379,
  "REDIS_USERNAME": "readonlyuser",
  "REDIS_PASSWORD": "password",
  "REDIS_DB": 0,
  "REDIS_TLS": false
}
```

Only `REDIS_HOST` is required; the port defaults to 6379. `config.example.json` shows the shape.

## Installing it

Published as `@kealthas-dev/opencode-redis-query`. `npm install -g @kealthas-dev/opencode-redis-query` puts `opencode-redis-query` on `PATH`; then create the account and write the config file. See SETUP.md step 12.

## Status

`redis.test.ts` runs against a real Redis in the docker sandbox (see `docker/notes.md`, "Redis test instance"), as the sandbox's `readonlyuser`, with data seeded and writes checked over a second connection as the default user: strings, integers, lists, hashes, sorted sets and `SCAN` replies, a missing value, quoting as `redis-cli` reads it, `$`/backticks/backslashes arriving untouched, `| head` closing the pipe early, writes refused with Redis's own `NOPERM` and nothing written, an unknown command, a wrong password, an unreachable Redis failing at once, usage errors, and a missing or broken config file.
