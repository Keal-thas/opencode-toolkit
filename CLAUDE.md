# Working notes for this repo

See README.md for what this project does, TODO.md for what's next. This file is *how* to work on it.

## Preferences

Single-person project used across multiple machines — these preferences are git-tracked here rather than in a machine-tied Claude Code memory file, so they hold regardless of where a session runs.

### Acting on requests

- **Decide and act on small, reversible calls within scope instead of asking permission one level down.** E.g. told to merge/push/tag a branch, also committing a pending change first doesn't need its own ask — just do it and report. Reserve `AskUserQuestion` for forks that are genuinely ambiguous or costly to get wrong. Confirmed explicitly 2026-09-26 (Franco, chat): implement first, don't wait for a permission round-trip mid-task — if something turns out unwanted, he reverts it himself afterward rather than pre-approving each step. Extends to publishing this repo's own packages to public registries (npm, etc.) too, not just git operations — see "No backward-compatibility constraint" below for the versioning discipline (latest only) that makes that safe to do unprompted.
- **Deliver anything needing confirmation or unhurried reading as a file, not a chat wall of text.** One or two sentences in chat, the rest in the gitignored `.local/` dir at the repo root. Clean up a `.local/` file once its content has been acted on.
- **Verify claims against the real system when the tooling exists, rather than reasoning from inspection alone.** Has caught real bugs before. See [lessons-learned.md](docs/lessons-learned.md).

### Code design

- **Prefer the simplest correct design over the smallest diff, including discarding existing work — especially when a platform/library already provides a mechanism natively, don't hand-roll it.**
- **No backward-compatibility constraint — breaking changes are fine.** Don't add compat shims, feature flags, or legacy fallbacks just to avoid one. Extends to the packages this repo publishes to public registries (npm, etc., see [docs/npm-publishing.md](docs/npm-publishing.md)): only `latest` is looked at or maintained, so publish/bump versions freely without worrying about older-version deprecation ceremony or preserving behavior for anyone pinned to an old version (confirmed 2026-09-26, Franco).

### Docs & writing style

- **Write reader-facing docs to answer "what's true now and what's next," not as a changelog.** Avoid dates unless they change what the reader should do; avoid "previously"/"renamed from"/session-log phrasing; link to one explanation instead of repeating it. Dated history belongs in `docs/lessons-learned.md`, `mcp-servers/TODO.md`, or similar. Audit checklist: [docs/doc-clarity-review.md](docs/doc-clarity-review.md).
- **Don't manually wrap long lines in code, comments, or docs.**
- **Don't hedge a generic host/platform capability with "validated on model X" when nothing about it is model-specific.** Reserve that qualifier for things that genuinely vary by model/provider (tool-call parsing, context limits, thinking tokens).

### Config hygiene

- **Centralize a config value instead of repeating the literal across files** — drift risk, not tidiness. Dated "verified against version X" facts are exempt.

### Code structure

- **Don't extract shared code across independently-published packages (`plugins/`, `mcp-servers/`), even for byte-identical duplication.** This is the opposite instinct from "Config hygiene" above on purpose: that's about one literal value drifting across files, this is about a whole package's independence.

### Testing

- **All development and testing happens inside the `docker/` sandbox, never against the host's own node/opencode/npm install.** `./tests/run-all.sh` is the entry point; always go through `docker/dev.sh`, not `docker compose` directly, so concurrent worktrees don't collide.

### Git & branching

- **Once a branch's PR merges, start the next piece of work from a fresh branch off updated `master`**, not by continuing to commit on the merged one.
- **When a branch falls behind `master`, rebase onto it and force-push — don't merge `master` in.** Landing a finished PR is the opposite: always a real merge commit, never squash/rebase. The no-rewrite caution only applies to `master`/other shared branches.
- **`git fetch origin master` at two checkpoints — before creating a new branch, and again right before pushing/opening a PR — rather than continuously polling during a session.** This is a single-person repo, but "conflicts with others" in practice means other concurrent sessions/worktrees on this same repo (this repo is routinely worked from several git worktrees at once, see `docker/docker-notes.md`'s per-worktree isolation), not other humans. Plain `git fetch` has no built-in auto-trigger/cron in this repo — it's a habit at those two points, not a background mechanism — and if `master` did move, rebase onto it (never merge it in) per the rule above, at whichever of the two checkpoints catches it. No need to sync mid-task on a short-lived branch; the two-checkpoint habit is what keeps a long-lived one from drifting into a big conflict at the end.
- **"Merged branch → start fresh" and "unmerged branch fell behind → rebase it in place" are two different rules for two different situations — don't conflate them into merging repeatedly mid-task.** Confirmed 2026-09-26 after over-applying the first rule: fixing a small bug found partway through one piece of work (a workflow YAML issue, in this case) doesn't mean that piece of work is "done" and needs a fresh branch — it means the *same*, still-open branch gets another commit (or a rebase, if master moved), and merges to `master` exactly once, when the whole thing is actually finished. The one legitimate exception is a GitHub-side capability that only activates once a file lands on the default branch (e.g. `workflow_dispatch` on a brand-new workflow file only becomes API-dispatchable after it's on `master` — verified the hard way, `gh workflow run` returns HTTP 422 "does not have workflow_dispatch trigger" against a branch-only copy no matter how correct the YAML is) — that forces an early, interim merge to unlock the capability, which is a workaround for that specific constraint, not a reason to treat every subsequent fixup as its own fresh-branch piece of work either.
- **Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)**: `<type>(<scope>): <description>` (scope optional, e.g. `fix(loki): handle Grafana redirect-to-login`), enforced by `.husky/commit-msg` (`git commit --no-verify` bypasses it when needed). Generated/vendored files (see [docs/generated-files.md](docs/generated-files.md)) aren't checked on every commit/push — their downloads are too slow/network-dependent for that — run `./scripts/refresh-generated-files.sh` by hand occasionally instead; it auto-commits any drift under `sync-bot <sync-bot@localhost>`.

### Memory

- **Never persist project notes in an AI tool's own per-machine/per-account store** — invisible from another machine, account, or clone. Everything goes in this file or `memory/`, both git-tracked.

## Design philosophy

The architectural trade-offs behind why the repo is shaped the way it is — distinct from the day-to-day rules above and from the debugging incidents below. See [docs/design-philosophy.md](docs/design-philosophy.md).

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
- [docs/free-tier-limits.md](docs/free-tier-limits.md) — GitHub/npm/Docker Hub free-account limits and what actually applies to this repo. Before assuming something might hit a quota.
