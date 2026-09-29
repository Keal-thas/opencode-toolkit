# Design philosophy

The architectural trade-offs behind why this repo is shaped the way it is — not the day-to-day working rules (`CLAUDE.md`'s Preferences) and not a log of specific debugging incidents (`docs/lessons-learned.md`). Each point below is self-contained; no need to chase a link elsewhere to understand it.

## Verify over reason

Reasoning from reading code or docs is not trusted on its own when a tool exists to check the real system directly — opencode's own docs have been caught disagreeing with its actual source in both directions, so "plausible from inspection" has a real, non-trivial failure rate here. The cost of spinning up a throwaway plugin or a real debug command is accepted as cheaper than shipping a wrong conclusion.

## Simplest correct mechanism over minimal diff

When a platform or library already provides a mechanism natively, that mechanism wins outright over a hand-rolled equivalent, even if it means discarding already-working code rather than patching it. A hand-written plugin that reconstructed opencode's system prompt by intercepting a transform hook was fully thrown away once a plain config field was confirmed to do the same thing natively — the replacement wasn't a refactor of the old code, it was a different mechanism entirely.

## No backward-compatibility constraint

Nothing external depends on this repo's internal implementation — it's deploy payload and tooling for one person on one target machine, not a library with outside consumers. Breaking changes, renames, and dropping dead code are all free moves; compatibility shims and feature flags to avoid a breaking change are pure cost with no corresponding benefit here.

## Isolate by the boundary that actually needs it, not narrower

The Docker sandbox isolates per git worktree (so parallel worktrees never collide), but not per concurrent invocation within one worktree — that narrower boundary was checked and found to already be safe, so no extra locking was added for it. Isolation is scoped to the exact axis where a real collision was possible, not applied uniformly for its own sake.

## A shared-resource decision needs its own measurement, not inherited rationale

A resource gets pulled out of per-worktree isolation into a single shared instance when running N copies would actually cost something — one test Oracle instance measures at roughly 2 GiB of RAM, so a copy per worktree risks OOM, which is what justifies sharing it. A second fixture (the test Loki instance) was made shared using the same file shape and the same justifying language, but it measures under 100 MiB — nowhere near enough to justify sharing on memory grounds. Its shared status is really about matching an existing pattern for consistency, not an independent cost argument, and that's a legitimate reason on its own — but it's a different reason, and stating the wrong one invites someone to "fix" it later based on a rationale that was never actually true for that resource.

## Pin third-party versions explicitly, never track latest

Every external component this repo's sandbox depends on — the opencode CLI itself, the test Oracle image, the test Loki image — has its version pinned in one place rather than resolved to whatever is newest at build time. A rebuild done months later reproduces the same environment instead of silently picking up an unrelated upstream change; bumping a version is always a deliberate, single-line edit, never an implicit side effect of rebuilding.

## Safety boundaries live at the account/permission layer, not in tool code

Where a tool exposes a genuinely open-ended capability (arbitrary SQL, arbitrary log-query syntax), the tool itself does no filtering or allow-listing — the account or credentials it's configured with are the actual safety boundary. This pushes the safety decision to configuration time (which account you point the tool at) instead of baking a necessarily-incomplete blocklist into the tool's own code.

## Documentation states what's true now, not how it got there

Reader-facing docs answer "what is this and why does it work this way," not "what changed since the last version." History, dates, and "previously X, now Y" phrasing are deliberately excluded from those docs — they'd go stale the moment the described state changes again, and every dated fact is a future correctness bug. Where the history genuinely matters (a design rationale for choosing X over Y, a debugging incident), it lives in one dedicated place, not scattered across whichever doc happened to be edited when the decision was made.

## Default to unattended, reversible action

Small, in-scope decisions get made and acted on directly rather than escalated for confirmation one level down, and this is a hard bias, not just a tolerance — git history makes almost every change in this repo cheap to undo, so the cost of occasionally acting on a judgment call that later gets reverted is treated as far lower than the cost of interrupting every few steps to ask. Confirmation is reserved for choices that are either genuinely ambiguous or expensive to reverse.

## Split a package by its actual installability boundary, not by convenience

Every unit that needs to be independently installable by some other mechanism gets its own package, even when that multiplies the number of packages published together. opencode's plugin loader installs a bare package name directly from the registry, so each plugin has to be its own package for that mechanism to work at all — bundling them would prevent installing just one. Each MCP server is a separately deployed CLI process with its own runtime dependencies (one pulls in a heavyweight database driver that the others don't need), so merging them would force an unrelated dependency onto every install. All of them are still released together under one shared version bump, accepting redundant republishing of unchanged packages, specifically to avoid tracking independent version numbers across many files.

## Duplication across independent packages is cheaper than coupling them

Each independently-published package (`plugins/*`, `mcp-servers/*`) stays self-contained, even where that means duplicating a handful of small, boring, mechanical functions (config loading, HTTP wiring) byte-for-byte across packages. A shared internal package to remove that duplication would add a coupling/versioning surface — import wiring, an extra publish step — that costs more than the duplication it would save, and it would work against the same installability boundary described above.

## The offline target machine is a root constraint, not a series of unrelated decisions

Several separate-looking choices — publishing to npm as a second channel alongside a GitHub release zip, vendoring a models-metadata snapshot instead of fetching it live, bundling language-server binaries into a package instead of downloading them at install time, pinning every third-party version instead of tracking latest — all trace back to the same fact: the machine this eventually runs on has no internet access. Treating that as one constraint that radiates outward, rather than as coincidentally-similar independent decisions, is what keeps the reasoning for any one of them consistent with the others.

## Chinese documentation only where a human follows it step by step live

Docs written for a human to execute directly, in the moment, on the target machine get a Chinese counterpart; reference material meant for a developer or an AI agent to read stays English-only. The split isn't about topic — it's about who is actually the reader for that specific document.
