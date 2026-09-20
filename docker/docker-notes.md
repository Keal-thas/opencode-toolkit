# Docker dev/test sandbox — working notes

`Dockerfile` + `docker-compose.yml` + `docker-compose.oracle.yml` (all in `docker/`) give a local, isolated container for exercising this repo's prompt/plugins against a real `opencode` install, without touching the host's own opencode config or trusting an all-permission agent with anything outside the container.

## Launching it

Always go through `docker/dev.sh`, not `docker compose` directly — it isolates each worktree's Compose project so two worktrees running the sandbox at the same time never collide (see "Per-worktree isolation" below). Run from the repo root:

```sh
docker/dev.sh run --rm opencode-dev
```

Drops you into an interactive bash shell as the container's `dev` user. Each invocation creates a fresh container and destroys it on exit (`--rm`) — fine, since nothing that matters lives in the container's writable layer (see below).

For one long-lived container to `exec` into repeatedly instead: `docker/dev.sh up -d`, then `docker/dev.sh exec opencode-dev bash`.

## Per-worktree isolation

`docker/dev.sh` hashes the calling worktree's absolute path into `COMPOSE_PROJECT_NAME` before invoking `docker compose -f docker/docker-compose.yml`, so Compose auto-derives distinct project/network/container names per worktree (`docker-compose.yml` itself has no top-level `name:` or `container_name:` — letting Compose auto-derive both is what makes this collision-free). Verified live: 20 concurrent `run --rm` calls in one project never collided on a container name, and two different worktree paths (hashed to different `COMPOSE_PROJECT_NAME`s) ran fully concurrently with no interference — see [docs/lessons-learned.md](../docs/lessons-learned.md). No locking/serialization within a single worktree either — concurrent `docker/dev.sh run` calls from the *same* worktree are safe on their own.

The image tag (`opencode-toolkit-dev:latest`) stays fixed and global on purpose, unlike the container name — rebuilding the multi-GB toolchain per worktree would be wasteful, and it doesn't depend on worktree identity. Known residual risk from that: see TODO.md's build-race item.

## What actually persists, and where

- **Nothing in `~/.config/opencode`/`~/.local/share/opencode` persists across containers anymore** — no named volumes for these (removed 2026-09-14; see docs/lessons-learned.md for why). They live entirely in the container's own writable layer and reset with it on every `--rm`. `docker-entrypoint.sh` (re)generates `opencode.jsonc` fresh on every start instead (see "Verifying the system-prompt override" below) — nothing else would ever populate it now.
- **The project directory itself persists via a live bind mount, not container-lifecycle persistence** — `docker-compose.yml` bind-mounts the repo root to `/home/dev/project`: edits to `deploy/system-prompt.txt` on the Mac host show up immediately, no rebuild. `plugins/system-prompt-tools/` does **not** get this anymore now that it loads as a real published npm package by bare name instead of read from the raw `.ts` path — editing the source needs a new published version and then an image rebuild (see "Plugin dependency pre-warming" below) since the install is pre-warmed into the image layer, not read fresh from the bind mount on every start.
- **The plugins' `node_modules`/package cache persist because they're baked into the image itself**, not a volume — see "Plugin dependency pre-warming" below.
- **`oracle`'s data persists in its own volume**, in its own compose project — see "Oracle test instance" below.
- **Does NOT persist** — anything else written inside the container (files elsewhere in `/home/dev/`, an ad-hoc `apt-get install`, other scratch state) — lives in the writable layer, wiped the moment `--rm` destroys it.

## Container user

Runs as `dev` (uid/gid 1000 by default, overridable via the `UID`/`GID` build args) — a plain Linux user created in the `Dockerfile`, unrelated to any Docker Hub/registry account.

## Dockerfile gotchas, if rewriting it from scratch

- `node:22-bookworm` already ships a `node` user/group at uid/gid 1000 — collides with creating `dev` at the same default IDs. Fixed by dropping the unused `node` user/group first.
- Everything the `dev` user needs to write to at runtime (`~/.config/opencode`, `~/.local/share/opencode`) is created and `chown`'d at build time now, not fixed up by the entrypoint at container start — there's no volume that would reset that ownership anymore.

## Plugin dependency pre-warming

The `system-prompt-tools` plugin (`plugins/system-prompt-tools/`) is a real published npm package (`@kealthas-dev/opencode-system-prompt-tools`), referenced in the `plugin` config array by its bare name — no version, no path, no `file:` spec (see CLAUDE.md and `docs/feature-points/02-system-prompt-tools-plugin.md` for why — `plugins/hook-logger/` and `plugins/llm-review-gate/` each use this same pattern, as their own independent packages). opencode resolves a `plugin` entry by installing it (a real `npm install`) into `~/.cache/opencode/packages/<the spec string, with an implicit "@latest" appended when no version is given>/`, and skips that work entirely if the directory is already there — confirmed live against the real npm registry: ~3.9s cold (genuine network install) vs. ~0.45s warm. The Dockerfile exploits that directly: it writes a throwaway seed `opencode.jsonc` listing just this plugin and runs `opencode debug config` once — which does the real install (landing at `~/.cache/opencode/packages/@kealthas-dev/opencode-system-prompt-tools@latest/`) and also installs opencode's own `@opencode-ai/plugin` dependency into `~/.config/opencode/node_modules` — all at **image build time** rather than on every container start. Without this, every fresh container (no more config volume — see above) would pay opencode's ~20-25s cold install on first use of a `plugin` config entry — measured, pure network wait. Paying it once at build time means every container already has it warm (measured: 0.6s vs 20-24s). This build step needs real outbound network access to the npm registry, unlike the rest of this sandbox.

This is opencode 1.18.30's own undocumented cache-key behavior (keying the install directory by the resolved `plugin` spec string — bare names get an implicit `@latest` — and skipping re-install if it's already populated), not a contract its own docs (`docs/opencode-docs-reference/plugins.mdx`) make any promise about, beyond the general "npm plugins are installed automatically" statement — that doc also claims Bun does the install; observed reality in this sandbox is a plain `npm install` (real `package-lock.json` written into the cache dir, no `bun` binary even present on `PATH`), so don't take the "Bun" detail at face value either. Re-verify all of this still holds after bumping `OPENCODE_VERSION`.

The Dockerfile still uses `opencode debug config` as the step that reliably triggers and completes the `@opencode-ai/plugin` SDK-dependency install (~50-60s wall time the first time, no real provider needed) — running as the `dev` user so `HOME` resolves to `/home/dev`, matching where the entrypoint-generated config will look for it at runtime. Deliberately not `opencode run` for this — that has its own, unrelated hang bug in this sandbox (see [docs/lessons-learned.md](../docs/lessons-learned.md)).

**Two gotchas found while verifying this, both confirmed live, neither documented anywhere upstream:**

1. **A bad/nonexistent package name fails completely silently.** Pointing `plugin` at a name that 404s on the registry (tested by publishing nothing and referencing the real intended name before it existed) still makes `opencode debug config` exit 0, still shows a clean-looking `plugin_origins` entry for that spec, and writes nothing to `~/.local/share/opencode/log/opencode.log` — the only visible trace is an *empty* `~/.cache/opencode/packages/<name>@latest/` directory (no `package.json`, no `node_modules`) instead of a populated one. There is no reliable way to tell "installed fine" from "silently failed" by reading `opencode debug config` output alone — `plugin_origins` proves the spec was *parsed*, not that the install *succeeded*. The only real proof is checking the plugin's actual runtime effect (for `system-prompt-tools`, that `~/.local/share/opencode/last-system-prompt.txt` gets written after `opencode run` — SETUP.md step 9 already does this) or checking the cache directory actually has content.
2. **That empty failed-install directory is permanent and poisons every future attempt**, cold or warm, with no retry — same "skip if the directory already exists" logic that makes a *good* cache fast makes a *bad* one permanently broken. Concretely: **`docker/dev.sh build` reuses this layer via Docker's own build cache even after the real package is later published**, since the Dockerfile text hasn't changed — confirmed live: a rebuild with the exact same `RUN opencode debug config` line showed `CACHED`, not a fresh install, on a second build. Getting a working image after fixing the underlying package name requires `docker/dev.sh build --no-cache` (or any other change that busts this specific layer), not a plain rebuild. This same trap applies on the real target machine: if SETUP.md's plugin step ever runs against a not-yet-published or misspelled package name, the resulting `~/.cache/opencode/packages/<name>@latest/` directory needs to be deleted by hand before a retry will do anything.

Getting a newer published version into the image means rebuilding it (`docker/dev.sh build`) — a rebuild with an empty/fresh cache always picks up whatever's currently tagged `latest` on the registry, not a version baked into this repo. Editing `plugins/system-prompt-tools/system-prompt-tools.ts` on the host takes effect here only after it's published as a new version *and* the image is rebuilt, unlike `deploy/system-prompt.txt` (see "What actually persists, and where" above). `hook-logger`/`llm-review-gate` are not pre-warmed into the image at all — they're not wired into this sandbox's default config, only exercised by their own unit tests.

**History:** this plugin previously shipped as a raw `.ts` file with no packaging at all, auto-loaded from opencode's documented local-plugin directory (`~/.config/opencode/plugins/`) — simpler, and confirmed to work fully offline, but every local plugin then shared one dependency tree via a single `$CONFIG_DIR/package.json`, with no per-plugin version isolation. Switched to per-plugin tarball packaging 2026-09-17 (Franco's call) so each plugin could pin its own dependencies independently, same shape as `mcp-servers/oracle/`/`mcp-servers/loki/` — then switched again 2026-09-20 to publishing each plugin as a real npm package instead, once testing showed opencode's own npm-plugin loader does a real registry install rather than requiring a pre-seeded cache. The pinned-tarball approach was built around "the target machine has no internet at all"; once that machine was confirmed to have a working internal npm mirror, the manual cache-seeding step became unnecessary indirection.

## Provider API keys — loaded from `~/.keys`, never in .zshrc or the repo

`docker-compose.yml` bind-mounts `${HOME}/.keys` read-only to `/home/dev/.keys`. `docker-entrypoint.sh` reads specific files from there into env vars (e.g. `DEEPSEEK_API_KEY` from `~/.keys/.deepseek-key`) before dropping to the `dev` user — scoped to that container's process tree only, nothing persisted to the Mac's shell environment or written into this repo. An already-set `DEEPSEEK_API_KEY` in the invoking shell still wins, for a one-off override.

To add a key for another provider: drop a file in `~/.keys/` (`chmod 700` the directory itself — a plain no-exec directory silently blocks all access, including your own `ls`), then add one `if [ -f ... ]; then export ...; fi` block to `docker-entrypoint.sh` following the existing DeepSeek one.

Claude never reads these key files' contents directly (only checks filenames/lengths) and never writes a real key into any file — a hard rule, independent of how low-stakes the key is claimed to be.

## Pinned version

`opencode-ai`'s version is pinned in exactly one place: `OPENCODE_VERSION` in `docker/.env` (committed, secret-free — see its own header comment). `docker compose` loads it automatically and passes it into the `Dockerfile`'s `ARG OPENCODE_VERSION`. Deliberately not `@latest`, so a rebuild months from now reproduces the same environment instead of silently picking up a newer opencode. Bump by editing that one line (check `npm view opencode-ai version` first), then `docker/dev.sh build`.

## Base image Node version

`FROM node:22-bookworm` (bumped from `node:20-bookworm` 2026-09-13 for the `plugins/` TypeScript rewrite — Node 20 has no native TS support at all, 22 runs `.ts` files with type annotations natively, no flag needed). If a future plugin needs TS syntax that isn't purely type-erasable (enums, `namespace`, parameter-property shorthand), that still needs an actual transpile step — Node's type-stripping only erases annotations. Full story, and an unrelated `node --test` regression this bump surfaced: [docs/lessons-learned.md](../docs/lessons-learned.md).

## Oracle test instance, for exercising mcp-servers/oracle/

Lives in its own compose file/project, `docker/docker-compose.oracle.yml` (fixed project name `opencode-toolkit-oracle`), separate from `docker-compose.yml`'s per-worktree one — it's a genuinely shared, read-mostly test fixture, not per-worktree state, and would be forced into per-worktree isolation if it stayed in the same file (see "Per-worktree isolation" above). `oracle` (image `gvenzl/oracle-free`, version pinned via `ORACLE_FREE_VERSION` in `docker/.env`, same reasoning as `OPENCODE_VERSION`) gives `mcp-servers/oracle/` a real Oracle instance to test against.

**`docker/dev.sh` brings it up automatically before `run`/`up`, by deliberate choice** — `docker compose -f docker/docker-compose.oracle.yml up -d --wait`, idempotent, blocking until healthy. This replaces the `depends_on: condition: service_healthy` the old single-file design used; `depends_on` can't reach across separate compose projects, which is what splitting `oracle` out required. Accepted tradeoffs (weighed against the risk of a forgotten manual start):
- idle RAM/CPU for `oracle` on every sandbox session, even ones unrelated to it
- on a fresh machine or wiped volume, first-time DB init (1-3 min) blocks every `opencode-dev` invocation via `dev.sh`, not just ones touching `mcp-servers/oracle/`
- `docker/dev.sh` fails outright if `oracle` can't become healthy

First-time init takes 1-3 minutes and only happens once — the `oracle-data` volume (in `docker-compose.oracle.yml`'s own project) persists it. Once warm, later starts are `healthy` within seconds. `oracle` keeps running after a `run --rm opencode-dev` session exits, and across every worktree — stop it explicitly with `docker compose -f docker/docker-compose.oracle.yml down`.

Reachable from `opencode-dev` as `oracle:1521/FREEPDB1` via Compose service-name DNS, even though the two containers belong to different compose projects — `docker-compose.yml` joins `docker-compose.oracle.yml`'s network as `external: true` (both declare the same fixed network name, `opencode-toolkit-oracle-net`), and Compose's service-name DNS resolution works per-network, not per-project. `opencode-dev`'s `environment` block pre-wires `ORACLE_CONNECT_STRING`/`ORACLE_USER`/`ORACLE_PASSWORD` to match, so `cd mcp-servers/oracle && npm install && npm start` just works with zero setup. Credentials (`ORACLE_APP_USER`/`ORACLE_APP_USER_PASSWORD` in `docker/.env`) are throwaway sandbox fixtures, never exposed outside this docker network.

## Loki test instance, for exercising mcp-servers/loki/

Same shared-fixture shape as the Oracle section above: its own compose file/project, `docker/docker-compose.loki.yml` (fixed project name `opencode-toolkit-loki`), separate from `docker-compose.yml`'s per-worktree one. `loki` (image `grafana/loki`, version pinned via `LOKI_VERSION` in `docker/.env`, same reasoning as `OPENCODE_VERSION`/`ORACLE_FREE_VERSION` — pins the *sandbox's test instance* only, not a requirement `mcp-servers/loki/server.js` itself imposes, since the Loki HTTP query API it calls has been stable across 2.x/3.x) gives `mcp-servers/loki/` a real Loki instance to test against. Runs with its stock default config (`auth_enabled: false`, filesystem storage) — no mounted config file needed, confirmed by reading the image's real upstream `cmd/loki/loki-docker-config.yaml` rather than assumed.

**`docker/dev.sh` brings it up automatically before `run`/`up`**, same as `oracle`, but readiness is checked differently: `loki`'s official image is built `FROM gcr.io/distroless/static:nonroot` (confirmed from its real upstream `cmd/loki/Dockerfile`) — no shell, `wget`, or `curl` inside the container, so it can't run a Docker `HEALTHCHECK` the way `gvenzl/oracle-free` does. `docker/dev.sh` instead publishes the container's port to `127.0.0.1:3100` and polls `/ready` from the host in a short retry loop after `up -d` (no `--wait`, since there's no healthcheck for it to wait on). Loki has no slow first-time DB init like Oracle's, so this is normally sub-second — the retry loop is a safety margin, not an expected wait.

First-time init is effectively instant (no schema/DB bootstrap) — the `loki-data` volume (in `docker-compose.loki.yml`'s own project) still persists ingested test data across container restarts, same pattern as `oracle-data`. `loki` keeps running after a `run --rm opencode-dev` session exits, and across every worktree — stop it explicitly with `docker compose -f docker/docker-compose.loki.yml down`.

Reachable from `opencode-dev` as `loki:3100` via Compose service-name DNS, same `external: true` shared-network join as `oracle-net` (`opencode-toolkit-loki-net`). `opencode-dev`'s `environment` block pre-wires `LOKI_BASE_URL=http://loki:3100`, so `cd mcp-servers/loki && npm install && npm start` just works with zero setup. No credentials needed — the sandbox's `loki` runs unauthenticated, matching `mcp-servers/loki/README.md`'s "auth is optional" design.

## Verifying the system-prompt override actually works

**Automatic now, not a manual step.** `docker-entrypoint.sh` (re)generates `~/.config/opencode/opencode.jsonc` fresh on every container start — `agent.build/plan/general.prompt` wired to `/home/dev/project/deploy/system-prompt.txt` (the bind-mounted, live file) and the diagnostic plugin loaded via the bare `@kealthas-dev/opencode-system-prompt-tools` (the published npm package, pre-warmed into opencode's own package cache at image build time — see "Plugin dependency pre-warming" above). There's no config volume to hand-edit anymore.

Automated end-to-end in `../tests/integration/docker-prompt-override.test.sh` (run via `../tests/run-all.sh`) — launches its own disposable container (via plain `docker run`, not `docker/dev.sh`, since it's testing the container's own startup path directly) and asserts `opencode debug config` resolves `agent.*.prompt` to `system-prompt.txt`'s exact content.

To reproduce by hand inside an interactive `docker/dev.sh run --rm opencode-dev` session, just run `opencode debug config` directly — the config is already there, generated by the entrypoint before your shell even started.
