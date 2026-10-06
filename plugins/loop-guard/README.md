# loop-guard

Stops a model calling the same tool with the same arguments over and over, which is the commonest way a small local model gets stuck. Why this is a hook and not a prompt line: [docs/design-philosophy.md](../../docs/design-philosophy.md). Where the idea comes from: [docs/multi-agent-prior-art.md](../../docs/multi-agent-prior-art.md).

- Package: `@kealthas-dev/opencode-loop-guard`, source `loop-guard.ts`.
- Not yet published and not in `deploy/opencode.json.example`; see `TODO.md`. Until then it works as a hand-copied file in a plugins directory.

## Behavior

Per session, it tracks the last call (tool name plus arguments, key order ignored) and how many calls in a row repeated it.

- From the 3rd consecutive identical call whose output is also identical, a notice is appended to the tool output telling the model to stop and make a different call or answer.
- The 6th identical call to `read`, `grep` or `glob` is refused with an error, and stays refused until the model does something different. Tools with side effects (`bash`, `edit`, ...) only ever get the notice, since repeating them can be deliberate.
- A call that returns a different output restarts the run, so reading a file again after it changed is never counted.
- Failing calls count too: a tool that throws never reaches `tool.execute.after`, so the run is counted in `tool.execute.before` and a read of a missing file repeated forever is refused like any other loop. The notice cannot be appended for them, because there is no output to append it to.
- A new user message resets the session. `task` is exempt.

The thresholds (3 and 5) and the tool lists are constants at the top of `loop-guard.ts`.

## Tests

`tests/unit/loop-guard.test.mjs` drives the hooks with plain objects: the notice at the 3rd call, the notice not disturbing the next comparison, a changed result and changed arguments restarting the run, the refusal at the 6th read-only call, failing calls, side-effect tools only warned, per-session state and the reset on a new user message. `tests/integration/guard-plugins.test.mjs` runs it in a real opencode against a fake model: the notice reaches the model on the 3rd identical `read` and the 6th is refused.
