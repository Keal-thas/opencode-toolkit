# Working notes for this repo

See README.md for what this project does, TODO.md for what's next. This file is *how* to work on it.

## Preferences

Single-person project used across multiple machines — these preferences are git-tracked here rather than in a machine-tied Claude Code memory file, so they hold regardless of where a session runs.

### Acting on requests

- **Decide and act on small, reversible calls within scope instead of asking permission one level down.** E.g. told to merge/push/tag a branch, also committing a pending change first doesn't need its own ask — just do it and report. Reserve `AskUserQuestion` for forks that are genuinely ambiguous or costly to get wrong.
- **Deliver anything needing confirmation or unhurried reading as a file, not a chat wall of text.** One or two sentences in chat, the rest in the gitignored `.local/` dir at the repo root. Clean up a `.local/` file once its content has been acted on.
- **Verify claims against the real system when the tooling exists, rather than reasoning from inspection alone.** Has caught real bugs before. See [lessons-learned.md](docs/lessons-learned.md).

### Docs & writing style

- **Write reader-facing docs to answer "what's true now and what's next," not as a changelog.** Avoid dates unless they change what the reader should do; avoid "previously"/"renamed from"/session-log phrasing; link to one explanation instead of repeating it. Dated history belongs in `docs/lessons-learned.md`, `mcp-servers/TODO.md`, or similar. Audit checklist: [docs/doc-clarity-review.md](docs/doc-clarity-review.md).
- **Don't manually wrap prose lines.** The editor (IntelliJ) soft-wraps, so write each paragraph as one source line. Code comments still wrap normally.
- **Don't hedge a generic host/platform capability with "validated on model X" when nothing about it is model-specific.** Reserve that qualifier for things that genuinely vary by model/provider (tool-call parsing, context limits, thinking tokens).

### Config hygiene

- **Centralize a config value instead of repeating the literal across files** — drift risk, not tidiness. Dated "verified against version X" facts are exempt.

### Testing

- **All development and testing happens inside the `docker/` sandbox, never against the host's own node/opencode/npm install.** `./tests/run-all.sh` is the entry point; always go through `docker/dev.sh`, not `docker compose` directly, so concurrent worktrees don't collide.

### Git & branching

- **Once a branch's PR merges, start the next piece of work from a fresh branch off updated `master`**, not by continuing to commit on the merged one.
- **When a branch falls behind `master`, rebase onto it and force-push — don't merge `master` in.** Landing a finished PR is the opposite: always a real merge commit, never squash/rebase. The no-rewrite caution only applies to `master`/other shared branches.

### Memory

- **Never persist project notes in an AI tool's own per-machine/per-account store** — invisible from another machine, account, or clone. Everything goes in this file or `memory/`, both git-tracked.

## Hard-won lessons

Historical debugging/verification lessons live in [docs/lessons-learned.md](docs/lessons-learned.md) — read it before repeating investigative work already done here.

## Repo map

| Dir | What |
|---|---|
| `deploy/` | opencode deployment payload for the target machine — see SETUP.md |
| `docker/` | dev/test sandbox — `.env` is intentionally committed, not secret; see `docker/docker-notes.md` |
| `plugins/` | opencode plugins, one npm package each: `system-prompt-tools` (dumps the sent prompt), `hook-logger` (logs every hook event), `llm-review-gate` (LLM safety-gates `bash` calls) — see `docs/feature-points/02-04` and `docker/docker-notes.md`'s Plugin loading section |
| `toolkits/` | scripts that drive opencode as a client, not a plugin or MCP server — `module-analysis/` so far, see its own README |
| `mcp-servers/` | MCP servers, one per subdir (`oracle`, `loki`, `java-lsp`, `spring-lsp`) — see each one's own README, and `mcp-servers/TODO.md` |
| `docs/` | research notes, reference docs, the upstream opencode docs mirror |
| `tests/` | test suite — `./tests/run-all.sh` is the entry point |
| `memory/` | git-tracked project memory |
| `scripts/` | release/maintenance scripts |

## Deep reference

Read these when the task actually touches their area — not needed for everyday work elsewhere in the repo:

- [docs/deployment-environment.md](docs/deployment-environment.md) — the target machine, the model, opencode upstream source pointers. Before touching `deploy/`/`SETUP.md`.
- [docs/npm-publishing.md](docs/npm-publishing.md) — how every package in this repo publishes together. Before cutting a release.
