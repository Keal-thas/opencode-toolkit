# llm-review-gate

Gates `bash` tool calls behind an LLM safety review. Before a command runs it is sent to a hidden, throwaway opencode session that answers ALLOW or BLOCK; this sits on top of opencode's own permission config, it does not replace it.

- Package: `@kealthas-dev/opencode-llm-review-gate`, source `llm-review-gate.ts`.
- **Opt-in.** The plugin line is commented out in `deploy/opencode.json.example` because it adds a hidden model call before every `bash` command and can block commands. Uncomment it to enable (SETUP.md step 5).
- Fails closed: a review error or timeout blocks the command (`FAIL_OPEN_ON_ERROR = false` in the source).
- Never reviews its own review session's calls, so there is no recursion.

## Why it is built this way

- **A dedicated `review-gate` agent** (defined in `deploy/opencode.json.example`, no `prompt` override, every tool denied except `review_verdict`). A per-request `system` field is appended after an agent's configured `prompt`, not substituted for it (checked against opencode's `packages/opencode/src/session/llm/request.ts`). Without a dedicated agent the reviewer would inherit the full coding-agent persona from `system-prompt.txt` and answer with chat or tool calls instead of a verdict.
- **One throwaway session per review**, created right before the prompt and deleted right after. A session is a stateful conversation; reusing one would grow its history by a command-and-verdict turn per review, inflating context and cost and contradicting the "judge this one command in isolation" framing. `session.create`/`session.delete` are metadata calls, not model calls.
- **The verdict is a real function call.** The plugin registers a `review_verdict(allow, reason?)` tool; `execute()` stores the arguments keyed by the review's session ID and `review()` reads them back after `session.prompt()` resolves. Plugin-registered tools are visible to every agent, so `deploy/opencode.json.example` denies it globally and allows it only for `review-gate`. If the model never calls it, `review()` falls back to parsing ALLOW/BLOCK from the text.
- It is the only plugin with a runtime dependency (`zod`, for the tool's argument schema); the others import only types.

## Tests and limits

- `tests/unit/llm-review-gate.test.mjs` drives it with a fake opencode client: both verdict paths and their precedence, skipped non-bash tools, the recursion guard, fail-closed behavior, the `review-gate` agent name, the tool name matching the permission config, one session per review. This covers the plugin's decision logic, not opencode's real dispatch.
- That throwing inside `tool.execute.before` really stops the tool is checked against a live server in `tests/capability-probes/hooks.probe.mjs`.
- Not verified against the real Qwen model: whether it reliably calls `review_verdict` rather than falling back to text.
