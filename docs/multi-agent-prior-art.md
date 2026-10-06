# Multi-agent prior art

What the existing opencode multi-agent projects do, which of their mechanisms this repo takes, and what it leaves. The target machine is offline and runs a local Qwen model, so "take" means re-implement as a small plugin here, not install the project.

Read: [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) ("omo", 5.0 docs and the `packages/` source), [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) ("slim", 3.0.2 docs and `src/`), [mark-hingston/opencode-workflows](https://github.com/mark-hingston/opencode-workflows) (deprecated in favour of [keystone-cli](https://github.com/mhingston/keystone-cli)). Known only from their package pages, not read as source: `mcrescenzo/opencode-workflows` and `opencode-rgr-loop`. None of them was run.

## Where each project puts the graph

The tension in this area is a probabilistic model driving a deterministic structure. The projects differ in how much of the structure is enforced by code.

| Where the graph lives | Who | Enforced by |
|---|---|---|
| In the prompt, maintained by the model | slim's orchestrator, omo's bare `ulw` | nothing at runtime |
| A plan file of checkboxes, with code that continues the run | omo `/ulw-plan` then `/ulw-execute` (`.omo/plans/*.md`, `.omo/boulder.json`, `ledger.jsonl`) | a continuation component, and an independent reviewer that must verify before a checkbox flips |
| A graph the model generates, executed by an engine | omo `mass-ulw` (nodes with `dependsOn`, an event log with 17 event types, a definition fingerprint), keystone `dynamic` step (supervisor LLM generates steps, `confirmPlan`, `maxReplans`) | a node state machine plus a persisted journal |
| A graph a human wrote | workflows plugin, keystone's ordinary steps | the engine |
| A state machine owned by code, models only submit through typed tools | `opencode-rgr-loop` (`rgr_submit_*`; assistant text is never parsed as state) | the plugin |

omo and slim both run their agent loop inside opencode and both ship a lot that is irrelevant here (frontend agents, terminal panes, marketplaces, update checkers, web search).

## Constraints on adopting

- omo is under SUL-1.0 (internal or non-commercial use, free non-commercial redistribution only): read it for ideas, copy nothing. Its 5.0 docs describe the senpi host; its own roadmap treats opencode as one adapter among several.
- slim is MIT but installs eleven npm dependencies, wants an experimental opencode flag for background subagents, and its built-in `context7`, `gh_grep` and web search tools and its update checker all need the internet.
- The model is a local Qwen, so mechanisms that compensate for small-model habits matter more than orchestration prompts tuned for frontier models.

## What this repo takes

| Mechanism | Source | Decision |
|---|---|---|
| Repeated identical tool call guard | slim `tool-loop-guard` | taken: [`plugins/loop-guard`](../plugins/loop-guard/README.md) |
| Guessed absolute path repair, and a clear error for a missing search path | slim `absolute-path-rescue`, `search-path-guard` | taken: [`plugins/path-guard`](../plugins/path-guard/README.md) |
| Ask several seats in parallel, then synthesize with a tool-less agent | slim `council` | taken: [`plugins/council`](../plugins/council/README.md) |
| Typed submission as the only way model output enters a state machine | `opencode-rgr-loop` | later, see below |
| Write receipts plus a completion gate | slim `deepwork-guard` | later |
| Hash-anchored edits that reject stale lines | omo `hashline-core` | later |
| Event-sourced node state with a fingerprinted definition | omo `mass-ulw` | later |
| Binding a verifier's verdict to a state change | omo ulw-execute (the reviewer flips the checkbox) | later; `plugins/verify-session` already produces the independent verdict |
| Tool-call JSON error reminder | slim `json-error-recovery` | not taken: whether opencode surfaces malformed arguments through `tool.execute.after` was not verified, and it already returns an error for them |
| Frontend agent, observer, panes, marketplace, update checker, model fallback chain, team mode, memory sidecar | both | not needed |

## Specifications for the plugins taken

Each plugin is its own npm package with no runtime dependency beyond what it needs, per [design-philosophy.md](design-philosophy.md). Thresholds are constants at the top of the file, not configuration.

### loop-guard

A small model's commonest failure is calling the same tool with the same arguments over and over.

- Fingerprint a call as the tool name plus its arguments serialized with sorted keys. Per session, track the last fingerprint and a run counter that advances only when the next call has the same fingerprint and byte-identical output. Anything different resets the counter, so a legitimate re-read after the file changed is never counted.
- At 3 identical runs, append a notice to the tool output telling the model to stop and change approach.
- At 5, refuse the next identical call by throwing from `tool.execute.before`, only for the read-only search and read tools (`read`, `grep`, `glob`). A refusal can only follow a run already confirmed identical, so overlapping parallel calls cannot trip it early.
- A failing call never reaches `tool.execute.after`, so runs are counted in `tool.execute.before` and a failing read repeated forever is refused too.
- A new user message resets the session; `task` is exempt.

### path-guard

Small models drop segments from absolute paths (`/home/u/Work/Project` for `/home/u/Work/Parent/Child/Project`) and the call then fails before the tool runs.

- For `read` (`filePath`), `glob` and `grep` (`path`): if the argument is an absolute path that does not exist, is not already inside the workspace, and contains no `.` or `..` segment, find the longest contiguous suffix of the workspace path that occurs in it. If it occurs exactly once and workspace plus the full remaining tail exists, rewrite the argument to that path. Otherwise leave the call alone. It never invents a path and never trims the tail.
- The repair logic takes the `path` module as a parameter so the Windows flavor, the deployment target, is tested on Linux.
- `grep` with a search path that does not exist silently searches the whole workspace and `glob` fails with a bare `ripgrep execution failed`, so both get an error naming the path. `read` already says `File not found`.

### council

For decisions where one answer from one model is not enough.

- A `council` tool takes a question and optional context, runs each seat in its own child session in parallel with its own steering prompt, then gives all answers to a synthesizer that has no tools.
- Seats use a read-only agent (read, glob, grep; everything else denied, including `council` itself). The synthesizer's agent denies every tool. Both agents are registered through the `config` hook so deployment needs no extra config.
- A seat that fails or times out is reported as missing. One surviving seat is returned as-is with a note; no survivors is an error.
- The report carries the consensus rating (`unanimous`, `majority`, `split`), the synthesized answer, the disagreements and every seat's own answer verbatim, so the model cannot present a split as agreement.
- Seats differ by prompt, not necessarily by model, so diversity is weaker than with several models; each seat may name a `provider/model` to change that. Seats and prompts come from an optional JSON file, with built-in defaults.
- Prompts are awaited with `session.prompt`, never fired with `promptAsync`, so the plugin avoids the duplicate-injection race described below.

## Designs for later

- **Typed submission.** If a long-running loop is built here, the state machine lives in plugin code, each role gets one tool per allowed transition with a schema (`submit_plan`, `submit_review`), and assistant text is never parsed for state. This is the cleanest answer to the model-versus-structure conflict because the model stays free inside a node and cannot step outside the schema between nodes.
- **Receipts and completion gate.** Record each write into a task directory as a receipt (path, size, content hash, session), witness only. When a progress file flips to `completed`, check every artifact it names has a receipt and refuse otherwise. The cost is code, not context.
- **Hash-anchored edit.** Tag read lines `LINE#HASH`, require edits to quote the tag, reject when the line changed. Guards against edits on stale content; needs its own `edit` tool.
- **Journaled node state.** An append-only event log per run, node states, a fingerprint of the definition, and amendments that report which nodes they invalidate, so finished nodes are never re-run.
- **Verdict bound to state.** `/verify` produces `PASS | FAIL | UNVERIFIABLE`; a later step could make that verdict the only thing that can mark work done.

## Host pitfalls the prior art ran into

- Injecting prompts into a live session from several hooks races: they all see the same idle event and each injects once. omo ended up with a single module that is the only caller of `session.prompt`/`promptAsync`, a per-session reservation taken before dispatch, and a short hold after it (its RFC is `docs/reference/prompt-async-gate-rfc.md` in that repository). `session.promptAsync` can return before the prompt is durably accepted, with a `session.error` arriving later for the same attempt.
- `task_result`-style tools return only a subagent's last message; a result that is missing or empty must not be read as completion (slim tracks an explicit "status uncertain" state).
- A specialist asked for work outside its role should refuse and say why rather than do part of it, and the caller must not resend the unchanged task to the same specialist (slim's task-fit rejection).
