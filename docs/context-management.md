# Context management: what opencode actually does

Measured against opencode 1.18.33 with `tests/capability-probes/compaction.probe.mjs` (scripted fake provider reporting token usage, a real `opencode serve`). Treat anything not listed here as unverified.

## Big tool outputs are truncated before they reach the model

The full output is saved under `~/.local/share/opencode/tool-output/` and only a capped copy enters the history. The cap is roughly 50 KB / 2000 lines per call, and the shape differs per tool:

| Tool | What the model sees |
|---|---|
| `bash` | the **tail** (e.g. 100000 lines of `seq` → last ~12 KB), prefixed with `...output truncated...` and the saved-file path. A single 120 KB line → last ~50 KB |
| `read` | the **head**, capped at 50 KB, ending in `(Output capped at 50 KB. Showing lines 1-932. Use offset=933 to continue.)`. No saved file; the model pages with `offset` |
| MCP tools | the **head** up to ~50 KB, then `...N bytes truncated...`, the saved-file path and a hint to delegate to the `explore` agent via Task. MCP results are not exempt |

So one tool call costs at most ~12–13K tokens, but a long session of them still fills the window; that is what prune and compaction are for.

## Auto compaction

- Trigger: before the next model request, if the **provider-reported** token count of the last finished assistant message is at or above the usable window. opencode's own estimate is not used, so a provider that does not return `usage` never triggers it.
- Usable window, with the model's declared `limit`:
  - `limit.input` set: `input − reserved` (default `reserved` ≈ min(20000, `limit.output`)).
  - only `limit.context` and `limit.output` set: `context − output`. **`compaction.reserved` has no effect in this case.**
  - **no `limit` declared: never compacts**, even at 1,000,000 reported tokens. A hand-written custom provider/model block gets no limit unless it sets one, so declare `limit.context` and `limit.output` there (and `limit.input` if `reserved` should apply).
- `compaction.auto: false` stops it (same behaviour as `OPENCODE_DISABLE_AUTOCOMPACT`).
- What happens: the `compaction` agent gets a request with no tools whose system prompt is a "context summarization agent" and whose single user message is the whole conversation rendered as text (`[User]: …`, `[Assistant tool call]: …`, `[Tool result]: …`) plus a template to fill in. The next normal request then contains the summary plus a synthetic user turn ("Continue if you have next steps, or stop and ask for clarification…"); the earlier messages and tool results are gone from it.

## Prune

`compaction.prune` is **off by default**; with it unset or `false`, five 49 KB tool outputs stayed in the request through three further turns. With `prune: true`, the oldest outputs beyond a protected tail of recent ones are replaced by `[Old tool result content cleared]` (the 2 oldest of 5 here, ~12K tokens each, the newest 3 kept; upstream's source reads as a 40K-token protected tail and the two latest user turns exempt, not separately probed). The message and tool call stay, only the result text goes.

## For the target deployment

The 128K ceiling is not known to opencode unless the model block says so. Check that the provider's model definition carries `limit` (`context: 131072`, plus `output`), otherwise auto compaction never fires and the first sign of trouble is the server rejecting an oversized request. Consider `compaction.prune: true` as well.
