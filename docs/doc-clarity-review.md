# Documentation clarity review

A manually-triggered checklist for auditing this repo's reader-facing docs against the doc-writing rule in [CLAUDE.md](../CLAUDE.md)'s Preferences section ("write reader-facing docs to answer what's true now and what's next, not as a changelog"). Nothing runs this automatically — invoke it by pointing an agent at this file when a documentation pass is wanted, e.g. after a cluster of related edits has left dated/history phrasing scattered across several files.

## Scope

The reader-facing doc set is the same one CLAUDE.md's Preferences bullet names: README.md, SETUP.md, CLAUDE.md itself, `docs/feature-points/*`, subpackage READMEs (`mcp-servers/*/README.md`, `plugins/*/README.md`, `toolkits/*/README.md`), and `memory/*` — plus the reference docs CLAUDE.md links out to (`docs/deployment-environment.md`, `docs/npm-publishing.md`), which carry the same "what's true now" contract despite living outside CLAUDE.md itself. Files whose whole purpose is historical or decision-oriented — `docs/lessons-learned.md`, `mcp-servers/TODO.md`, narrowly-scoped decision notes — are out of scope for this pass; dated history belongs there, not removed from there.

## What counts as drift

Grep the in-scope files for these patterns. Each hit is a candidate, not an automatic cut — judge case by case per "How to decide" below.

- Dates that don't change what the reader should do right now (a "verified against version X on date Y" fact is exempt — see CLAUDE.md's config-drift bullet).
- `previously`, `renamed from`, `converted from`, `this session`, `added on`, or similar changelog phrasing inside otherwise-current instructions.
- A standalone `History:`/`**History:**` paragraph or section.
- The same decision explained in more than one file.
- Snapshot-in-time phrasing not anchored to a date — "this is the first time X runs", "currently only", "for now" used to describe a fact about *this specific occasion* rather than a durable property of the system. Unlike a dated fact, this kind of claim silently goes stale with no timestamp to flag it: reread instructional docs (SETUP.md and its non-English mirrors especially) for a sentence that will become false the next time the same steps are followed.
- Run this check per doc file, not per pattern-language — a doc's `.zh.md`/other-language counterpart needs the same read for its own language's equivalent phrasing, not just a grep for the English trigger words.
- A mechanism's doc (a CI workflow, a config field, a script) that no longer matches what the mechanism's actual source now does. Check the real source (the workflow YAML, the script, the schema) directly rather than cross-checking one doc against another — two docs can agree with each other while both being stale relative to the code.

## How to decide what to cut vs keep

The trap: a `History:`/dated paragraph usually bundles two different things together, and deleting the whole paragraph deletes both even though only one of them is actually stale.

1. **Chronology** — when something happened, what it used to be called, who decided it, which iteration came before which. This is genuinely disposable from a reader-facing doc: cut it, or move it to `docs/lessons-learned.md`/`mcp-servers/TODO.md` if it's the kind of incident those files exist to record.
2. **Rationale** — why the current mechanism was chosen over a simpler or more obvious alternative. This is a non-obvious WHY, the same category of thing this repo's own code-comment rule protects: if a future reader would have to redo research to answer "why didn't we just do the simple thing," that sentence is rationale, not history, and needs to survive somewhere — inline (with the dates stripped) if it's short, or in `docs/lessons-learned.md` if it's long enough to clutter the current doc.

Before deleting a `History:` paragraph or dated aside, reread it once specifically looking for rationale (signals: "because", "so that", "instead of", "tradeoff", "gives every X" — a consequence clause, not just a timestamp). Don't delete on the first pass just because it's wrapped in history-shaped prose.

This checklist exists because that exact mistake happened once already — see the `docker/docker-notes.md` entry in [docs/lessons-learned.md](lessons-learned.md).

## Doing the pass

Grep the trigger patterns above first to find the obvious cases, but grep alone is not the review — it only catches phrasing that happens to match a known trigger word, in the language you thought to search. Read every in-scope file end to end at least once per pass. A completeness gap (a doc describing a mechanism that gained a step/behavior the doc never absorbed) doesn't announce itself with any of the trigger words above; it only shows up by actually reading the doc's claim and checking it against the real source it describes.

## Verification

- `git diff --check` for whitespace/patch issues.
- For every paragraph fully deleted (not just trimmed), grep the surviving repo for its key nouns before moving on — confirm any rationale it carried actually survives somewhere, rather than assuming the cut was safe.
- No functional tests apply to a docs-only pass.
