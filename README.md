# opencode tooling workspace

A workspace for building on top of `opencode` (the CLI coding agent): a system-prompt override, custom opencode plugins, a script for using opencode to analyze a large codebase, and MCP servers for LAN-internal ops tooling plus LSP-backed Java/Spring code intelligence. See "Repo layout" below for the rest.

[SETUP.md](SETUP.md) has the prompt override's setup instructions, written to be handed directly to an agent and executed step by step (the target machine is network-restricted, not something to do by hand repeatedly). This README is the human-readable explanation of what it does and why. [USAGE.zh.md](USAGE.zh.md) is a short Chinese usage manual covering the same deployment steps at a glance, for a human watching or doing the deployment — this README doesn't have an English equivalent since it already covers that ground.

## Repo layout

| Dir | What |
|---|---|
| `deploy/` | The opencode deployment payload for the target machine — prompt override, full `opencode.json` config (incl. MCP wiring), and the offline models catalog snapshot |
| `docker/` | Local Docker sandbox for exercising this workspace's prompt/plugins against a real opencode install, without touching your own machine's config; see `docker/docker-notes.md` |
| `plugins/` | Three independent opencode plugins, one subdirectory/npm package each: `system-prompt-tools/` (the prompt override's diagnostic plugin) plus `hook-logger/`/`llm-review-gate/` (general "writing tools for opencode", not the prompt override) |
| `toolkits/` | Standalone scripts that drive opencode as a client via `@opencode-ai/sdk` — `module-analysis/` (generates an architecture map of a large codebase, own thing, not tied to the prompt override; see `toolkits/module-analysis/README.md`) so far, more may be added |
| `mcp-servers/` | MCP servers: LAN-internal ops tooling (`oracle/`, `loki/`), the official memory server wiring, and LSP-backed Java/Spring code intelligence (`java-lsp/`, `spring-lsp/`); see `mcp-servers/TODO.md` |
| `docs/` | Research notes, a local mirror of opencode's own docs, a feature-by-feature inventory of this workspace ([docs/feature-points.md](docs/feature-points.md)), and an index of every generated/vendored file in the repo ([docs/generated-files.md](docs/generated-files.md)) |
| `tests/` | Automated tests covering this workspace's feature points; `./tests/run-all.sh` is the entry point — see `tests/README.md` |
| `memory/` | Git-tracked project memory |
| `scripts/` | One-off release/maintenance scripts, e.g. `publish-npm.sh` |
| `package.json` / `.npmignore` | Package the whole git-tracked tree as `@kealthas-dev/opencode-toolkit` on public npmjs.com, purely as a second download channel for the restricted target machine's internal npm mirror (`npm pack`) alongside the GitHub Release zip below — see CLAUDE.md |
| `CLAUDE.md` | Working notes for whoever edits this repo further |
| `TODO.md` | Concrete follow-up work still to be done |

## System-prompt override

opencode overrides the system prompt it sends to a model using its own config — no plugin required for the override itself.

### What's in `deploy/`

- `system-prompt.txt` — the replacement prompt content, edit to taste. Also carries a `# Memory` policy section for the memory MCP server below.
- `opencode.json.example` — the config that wires `system-prompt.txt` in, plus MCP entries: `oracle`/`loki` (this repo's own LAN-ops servers, see `mcp-servers/`), `java-lsp`/`spring-lsp` (LSP-backed code intelligence, also under `mcp-servers/`), and `memory` (the official `@modelcontextprotocol/server-memory` package — cross-session memory for opencode itself, not hosted in this repo; see `docs/feature-points/15-opencode-memory-mcp.md` and SETUP.md step 10). All enabled by default — each still needs its own server started/credentials supplied per SETUP.md before it actually works, so disable in `opencode.json` whichever ones aren't wanted.
- `models-dev-snapshot.json` — a local copy of opencode's models.dev metadata catalog, for the offline restricted machine to point `OPENCODE_MODELS_PATH` at instead of ever fetching it live (SETUP.md step 3). Optional — the offline build already has a build-time snapshot baked in as a fallback. Generated, not hand-authored — refresh with `./deploy/fetch-models-snapshot.sh`. See [docs/generated-files.md](docs/generated-files.md) for why it's both git-tracked and gitignored.

### What's in `plugins/`

One subdirectory per plugin, each its own npm package (`package.json` + the `.ts` source), published to the public npm registry — mirroring `mcp-servers/`'s one-thing-per-subdirectory shape:

- `system-prompt-tools/` (`@kealthas-dev/opencode-system-prompt-tools`) — diagnostic plugin that dumps the fully-assembled system prompt to a local file on every request, the only way to confirm the override is actually reaching the real model. See `docs/feature-points/02-system-prompt-tools-plugin.md`.
- `hook-logger/` (`@kealthas-dev/opencode-hook-logger`) / `llm-review-gate/` (`@kealthas-dev/opencode-llm-review-gate`) — general-purpose opencode tooling, unrelated to the prompt override, independently installable from each other. See `docs/feature-points/03-hook-logger-plugin.md` / `04-llm-review-gate-plugin.md`.

Installed by opencode's own npm-plugin loader from just the bare package name in `opencode.json`'s `plugin` array (SETUP.md steps 4/5) — see `docker/docker-notes.md`'s "Plugin loading" section for the mechanism and its gotchas.

### How the override works

opencode's per-agent `prompt` config field fully replaces the built-in provider prompt (e.g. `default.txt`) — verified by testing directly against a real opencode install. Environment info (the `<env>` block: working directory, git repo check, platform, date) and any configured `instructions` files are generated fresh by opencode itself and still get appended after your custom prompt, untouched.

### Why system-prompt.txt looks the way it does

Written for a professional user, so the hand-holding tone and few-shot examples in opencode's default `default.txt` are stripped out. But not everything cut stayed cut — after diffing against upstream `default.txt`, four things got put back:

- Never invent or guess a URL
- Explain a non-trivial or state-changing command before running it
- Don't take actions beyond what was actually asked
- Delegate broad/open-ended exploration to the Task tool

The first three are safety/quality guardrails, not hand-holding. The fourth is different: `default.txt` tells the model to delegate broad file search to the Task tool "to reduce context usage" — the rewritten tone section had flattened that into plain "prefer grep/glob," which gave the model no prompt-level reason to ever spawn a subagent. Restored, reworded.

`build`, `plan`, and `general` agents get this prompt (see `deploy/opencode.json.example`). `compaction`, `summary`, `title`, and `explore` each ship their own narrow, task-specific native prompt — nothing to do with coding style, overriding those would actively hurt them. `general`, however, has **no prompt field set at all** in opencode's source, same as `build`/`plan` — confirmed against upstream source, not just local `opencode debug agent` output. Left unconfigured it would silently fall back to the full hand-holding `default.txt` (and, before the Task-tool line was restored, would never even get invoked by the model). It gets the same override as `build`/`plan`.

### Status / open items

- The target machine runs opencode as an offline single-exe build with git-bash, but has no internet — the repo is downloaded as a zip on a separate machine with internet, then transferred over. SETUP.md assumes the extracted copy is already on disk and works entirely offline from there.

See [TODO.md](TODO.md) for concrete planned/needed follow-up work.
