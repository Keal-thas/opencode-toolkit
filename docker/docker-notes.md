# Docker dev/test sandbox — working notes

`Dockerfile` + `docker-compose.yml` + the two shared-fixture files (`docker-compose.oracle.yml`, `docker-compose.loki.yml`), all in `docker/`, give a local, isolated container for exercising this repo's prompt/plugins against a real `opencode` install, without touching the host's own opencode config or trusting an all-permission agent with anything outside the container.

## Launching it

The `oracle`/`loki` fixtures are machine-wide external resources, started separately from the sandbox (see "Oracle test instance" and "Loki test instance" below). Bring them up once, then launch the sandbox:

```sh
docker compose -f docker/docker-compose.oracle.yml up -d --wait
docker compose -f docker/docker-compose.loki.yml up -d
```

The sandbox itself always goes through `docker/dev.sh`, not `docker compose` directly — it isolates each worktree's Compose project so two worktrees running the sandbox at the same time never collide (see "Per-worktree isolation" below). Run from the repo root:

```sh
docker/dev.sh run --rm opencode-dev
```

Drops you into an interactive bash shell as the container's `dev` user. Each invocation creates a fresh container and destroys it on exit (`--rm`) — fine, since nothing that matters lives in the container's writable layer (see below).

For one long-lived container to `exec` into repeatedly instead: `docker/dev.sh up -d`, then `docker/dev.sh exec opencode-dev bash`.

## Per-worktree isolation

`docker/dev.sh` hashes the calling worktree's absolute path into `COMPOSE_PROJECT_NAME` before invoking `docker compose -f docker/docker-compose.yml`, so Compose auto-derives distinct project/network/container names per worktree (`docker-compose.yml` itself has no top-level `name:` or `container_name:` — letting Compose auto-derive both is what makes this collision-free). Verified live: 20 concurrent `run --rm` calls in one project never collided on a container name, and two different worktree paths (hashed to different `COMPOSE_PROJECT_NAME`s) ran fully concurrently with no interference — see [docs/lessons-learned.md](../docs/lessons-learned.md). No locking/serialization within a single worktree either — concurrent `docker/dev.sh run` calls from the *same* worktree are safe on their own.

The image tag (`opencode-toolkit-dev:latest`) stays fixed and global on purpose, unlike the container name — rebuilding the multi-GB toolchain per worktree would be wasteful, and it doesn't depend on worktree identity. Known residual risk from that: see TODO.md's build-race item.

## What actually persists, and where

- **Nothing in `~/.config/opencode`/`~/.local/share/opencode` persists across containers** — no named volumes for these. They live entirely in the container's own writable layer and reset with it on every `--rm`. `docker-entrypoint.sh` (re)generates `opencode.jsonc` fresh on every start instead (see "Verifying the system-prompt override" below).
- **The project directory persists via a live bind mount** — `docker-compose.yml` bind-mounts the repo root to `/home/dev/project`: edits to `deploy/system-prompt.txt` on the Mac host show up immediately, no rebuild. `plugins/system-prompt-tools/` loads as a real published npm package by bare name instead — opencode installs it fresh from the registry on first use, each container start (see "Plugin loading" below), so a newly published version shows up on the next container with no image rebuild needed.
- **`oracle`'s data persists in its own volume**, in its own compose project — see "Oracle test instance" below.
- **Does NOT persist** — anything else written inside the container (files elsewhere in `/home/dev/`, an ad-hoc `apt-get install`, other scratch state) — lives in the writable layer, wiped the moment `--rm` destroys it.

## Container user

Runs as `dev` (uid/gid 1000 by default, overridable via the `UID`/`GID` build args) — a plain Linux user created in the `Dockerfile`, unrelated to any Docker Hub/registry account.

## Dockerfile gotchas, if rewriting it from scratch

- `node:22-bookworm` already ships a `node` user/group at uid/gid 1000 — collides with creating `dev` at the same default IDs. Fixed by dropping the unused `node` user/group first.
- Everything the `dev` user needs to write to at runtime (`~/.config/opencode`, `~/.local/share/opencode`) is created and `chown`'d at build time now, not fixed up by the entrypoint at container start — there's no volume that would reset that ownership anymore.

## Plugin loading

`system-prompt-tools` (`plugins/system-prompt-tools/`) is a real published npm package (`@kealthas-dev/opencode-system-prompt-tools`), referenced in `opencode.jsonc`'s `plugin` array by bare name — no version, no path, no `file:` spec (`plugins/hook-logger/` and `plugins/llm-review-gate/` use the same pattern as their own independent packages, but aren't wired into this sandbox's default config — only exercised by their own unit tests). opencode installs it itself (a real `npm install` against the registry) into `~/.cache/opencode/packages/<name>@latest/` on first use. Nothing here persists across containers (see "What actually persists" above), so this install happens fresh on every container start and needs real outbound network access.

A misspelled or not-yet-published package name fails silently: `opencode debug config` still exits 0 and shows a `plugin_origins` entry for the spec, but `~/.cache/opencode/packages/<name>@latest/` ends up empty (no `package.json`, no `node_modules`) instead of populated — there's no reliable way to tell "installed fine" from "silently failed" from that output alone. The only real check is the plugin's actual runtime effect (`~/.local/share/opencode/last-system-prompt.txt` getting written after `opencode run` — SETUP.md step 11 does this) or the cache directory's contents.

**History:** this plugin previously shipped as a raw `.ts` file, auto-loaded from opencode's local-plugin directory (`~/.config/opencode/plugins/`) — simpler, but every local plugin then shared one dependency tree via a single `$CONFIG_DIR/package.json`, with no per-plugin version isolation. Packaging each plugin as its own published npm package, referenced by bare name, fixed that.

## Provider API keys — loaded from `~/.keys`, never in .zshrc or the repo

`docker-compose.yml` bind-mounts `${HOME}/.keys` read-only to `/home/dev/.keys`. `docker-entrypoint.sh` reads specific files from there into env vars (e.g. `DEEPSEEK_API_KEY` from `~/.keys/.deepseek-key`) before dropping to the `dev` user — scoped to that container's process tree only, nothing persisted to the Mac's shell environment or written into this repo. An already-set `DEEPSEEK_API_KEY` in the invoking shell still wins, for a one-off override.

To add a key for another provider: drop a file in `~/.keys/` (`chmod 700` the directory itself — a plain no-exec directory silently blocks all access, including your own `ls`), then add one `if [ -f ... ]; then export ...; fi` block to `docker-entrypoint.sh` following the existing DeepSeek one.

Claude never reads these key files' contents directly (only checks filenames/lengths) and never writes a real key into any file — a hard rule, independent of how low-stakes the key is claimed to be.

## Pinned version

`opencode-ai`'s version is pinned in exactly one place: `OPENCODE_VERSION` in `docker/.env` (committed, secret-free — see its own header comment). `docker compose` loads it automatically and passes it into the `Dockerfile`'s `ARG OPENCODE_VERSION`. Deliberately not `@latest`, so a rebuild months from now reproduces the same environment instead of silently picking up a newer opencode. Bump by editing that one line (check `npm view opencode-ai version` first), then `docker/dev.sh build`.

## Base image Node version

`FROM node:22-bookworm` (bumped from `node:20-bookworm` 2026-09-13 for the `plugins/` TypeScript rewrite — Node 20 has no native TS support at all, 22 runs `.ts` files with type annotations natively, no flag needed). If a future plugin needs TS syntax that isn't purely type-erasable (enums, `namespace`, parameter-property shorthand), that still needs an actual transpile step — Node's type-stripping only erases annotations. Full story, and an unrelated `node --test` regression this bump surfaced: [docs/lessons-learned.md](../docs/lessons-learned.md).

## Oracle test instance, for exercising mcp-servers/oracle/

Lives in its own compose file/project, `docker/docker-compose.oracle.yml` (fixed project name `opencode-toolkit-oracle`), separate from `docker-compose.yml`'s per-worktree one — it's a genuinely shared, read-mostly test fixture, not per-worktree state, and would be forced into per-worktree isolation if it stayed in the same file (see "Per-worktree isolation" above) — and it has to stay a singleton because one `oracle` instance uses ~2 GiB RAM (measured), so a copy per worktree would exhaust memory. `oracle` (image `gvenzl/oracle-free`, version pinned via `ORACLE_FREE_VERSION` in `docker/.env`, same reasoning as `OPENCODE_VERSION`) gives `mcp-servers/oracle/` a real Oracle instance to test against.

Start it manually — it's a machine-wide fixture independent of the per-worktree sandbox, so it stays up across worktrees and `run --rm` sessions:

```sh
docker compose -f docker/docker-compose.oracle.yml up -d --wait
```

`--wait` blocks until its healthcheck passes. First-time init takes ~10 seconds (measured against `23.26.3-slim`) and only happens once — the `oracle-data` volume persists it; once warm, later starts are `healthy` within seconds. Stop it explicitly with `docker compose -f docker/docker-compose.oracle.yml down`.

Reachable from `opencode-dev` as `oracle:1521/FREEPDB1` via Compose service-name DNS, even though the two containers belong to different compose projects — `docker-compose.yml` joins `docker-compose.oracle.yml`'s network as `external: true` (both declare the same fixed network name, `opencode-toolkit-oracle-net`), and Compose's service-name DNS resolution works per-network, not per-project. `opencode-dev`'s `environment` block pre-wires `ORACLE_CONNECT_STRING`/`ORACLE_USER`/`ORACLE_PASSWORD` to match; `mcp-servers/oracle/`'s server itself doesn't read those directly though (it's config-file-driven, see its README's Configuration section), so `docker-entrypoint.sh` turns them into `~/.config/kealthas-dev/opencode-mcp-oracle/config.json` (the server's own default-location path, not an env-var-pointed one) at container start — `cd mcp-servers/oracle && npm install && npm run build && npm start` still just works with zero setup. Credentials (`ORACLE_APP_USER`/`ORACLE_APP_USER_PASSWORD` in `docker/.env`) are throwaway sandbox fixtures, never exposed outside this docker network.

## Loki test instance, for exercising mcp-servers/loki/

Same shared-fixture shape as the Oracle section above: its own compose file/project, `docker/docker-compose.loki.yml` (fixed project name `opencode-toolkit-loki`), separate from `docker-compose.yml`'s per-worktree one. `loki` (image `grafana/loki`, version pinned via `LOKI_VERSION` in `docker/.env`, same reasoning as `OPENCODE_VERSION`/`ORACLE_FREE_VERSION` — pins the *sandbox's test instance* only, not a requirement `mcp-servers/loki/src/server.ts` itself imposes, since the Loki HTTP query API it calls has been stable across 2.x/3.x) gives `mcp-servers/loki/` a real Loki instance to test against. Runs with its stock default config (`auth_enabled: false`, filesystem storage) — no mounted config file needed, confirmed by reading the image's real upstream `cmd/loki/loki-docker-config.yaml` rather than assumed.

Start it manually, same as `oracle`:

```sh
docker compose -f docker/docker-compose.loki.yml up -d
```

No `--wait` here: `loki`'s official image is built `FROM gcr.io/distroless/static:nonroot` (confirmed from its real upstream `cmd/loki/Dockerfile`) — no shell, `wget`, or `curl` inside the container, so it can't run a Docker `HEALTHCHECK` the way `gvenzl/oracle-free` does. Loki has no slow first-time DB init, so it's ready within a second of `up -d`.

First-time init is effectively instant (no schema/DB bootstrap) — the `loki-data` volume (in `docker-compose.loki.yml`'s own project) still persists ingested test data across container restarts, same pattern as `oracle-data`. `loki` keeps running after a `run --rm opencode-dev` session exits, and across every worktree — stop it explicitly with `docker compose -f docker/docker-compose.loki.yml down`.

Reachable from `opencode-dev` as `loki:3100` via Compose service-name DNS, same `external: true` shared-network join as `oracle-net` (`opencode-toolkit-loki-net`). `opencode-dev`'s `environment` block pre-wires `LOKI_BASE_URL=http://loki:3100`; `mcp-servers/loki/`'s server itself doesn't read that directly though (it's config-file-driven, see its README's Configuration section), so `docker-entrypoint.sh` turns it into `~/.config/kealthas-dev/opencode-mcp-loki/config.json` (the server's own default-location path, not an env-var-pointed one) at container start — `cd mcp-servers/loki && npm install && npm run build && npm start` still just works with zero setup. No credentials needed — the sandbox's `loki` runs unauthenticated, matching `mcp-servers/loki/README.md`'s "auth is optional" design.

## Verifying the system-prompt override actually works

**Automatic now, not a manual step.** `docker-entrypoint.sh` (re)generates `~/.config/opencode/opencode.jsonc` fresh on every container start — `agent.build/plan/general.prompt` wired to `/home/dev/project/deploy/system-prompt.txt` (the bind-mounted, live file) and the diagnostic plugin loaded via the bare `@kealthas-dev/opencode-system-prompt-tools` (the published npm package — see "Plugin loading" above). There's no config volume to hand-edit anymore.

Automated end-to-end in `../tests/integration/docker-prompt-override.test.sh` (run via `../tests/run-all.sh`) — launches its own disposable container (via plain `docker run`, not `docker/dev.sh`, since it's testing the container's own startup path directly) and asserts `opencode debug config` resolves `agent.*.prompt` to `system-prompt.txt`'s exact content.

To reproduce by hand inside an interactive `docker/dev.sh run --rm opencode-dev` session, just run `opencode debug config` directly — the config is already there, generated by the entrypoint before your shell even started.
