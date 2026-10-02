# Project memory

Git-tracked so it travels with the repo to any machine or tool that clones it, instead of living only in one AI tool's local, per-machine memory store (which nothing else can read). This complements `CLAUDE.md` (how to work on the repo, technical lessons) with softer context: who's behind this project and the shape of it at a glance.

**Never write project notes into an AI tool's own per-machine/per-account store** (e.g. Claude Code's `~/.claude/projects/**` memory, or any other tool's local-only equivalent). It's invisible from another machine, account, or fresh clone, which defeats the reason this project keeps its memory git-tracked in the first place. Everything belongs here or in `CLAUDE.md`'s Preferences section instead — both travel with `git clone`.

- [Who's behind this project](user.md) — solo project, multiple machines/environments, technical/no hand-holding
- [What this project is](project.md) — one-paragraph orientation; the real detail lives in `README.md` and `CLAUDE.md`
