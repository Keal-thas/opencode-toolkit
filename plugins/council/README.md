# council

A `council` tool and a `/council <question>` command: put one question to several independent advisors in parallel, then have an advisor with no tools compare their answers and rate the consensus. For a decision where one model's single answer is not enough. Where the idea comes from: [docs/multi-agent-prior-art.md](../../docs/multi-agent-prior-art.md).

- Package: `@kealthas-dev/opencode-council`, source `council.ts`. It has a real `zod` dependency for the tool's argument schema, like [`llm-review-gate`](../llm-review-gate/README.md).
- Not yet published and not in `deploy/opencode.json.example`; see `TODO.md`. Until then it works as a hand-copied file in a plugins directory, with `zod` installed where opencode can resolve it.

## What happens on a call

1. The tool takes `question` and an optional `context` (file paths to read, the options being weighed).
2. Each seat gets its own child session in the project directory, running the `council-seat` agent with the shared advisor rules plus the seat's own steering prompt. All seats run in parallel. A seat may only `read`, `glob` and `grep`; every other tool, including `council` itself, is denied.
3. If at least two seats answered, a `council-synth` session, which has no tools at all, gets the question and the answers and replies with `CONSENSUS: unanimous | majority | split`, the answer, and the disagreements. It is told to use only what the advisors wrote and never to present a split as agreement.
4. The tool returns the synthesis followed by every seat's answer verbatim, so the calling model sees the disagreement itself, not only the summary.
5. All child sessions are deleted afterwards.

Failure handling: a seat that errors, times out or answers nothing is listed as `(no answer: ...)` and left out of the synthesis. One surviving seat is returned as a single opinion with a note that there is nothing to rate. No survivors is an error carrying the reasons. If the synthesis itself fails, the seat answers are still returned. Cancelling the call aborts every child session.

The prompts are awaited with `session.prompt`, never fired with `promptAsync`, so the plugin cannot race another hook into injecting a second prompt.

## Seats

The default seats are `skeptic` (what is wrong or risky), `architect` (structure and long-term cost) and `pragmatist` (the smallest correct thing). They differ by prompt, not by model, so their independence is weaker than with several models; point a seat at another model to strengthen it.

Optional config, read on every call so an edit applies without a restart, from `~/.config/kealthas-dev/opencode-council/config.json` (or `config-<name>.json` with `COUNCIL_CONFIG_ENV=<name>`, the same convention as the MCP servers):

```json
{
  "seats": [
    { "name": "reviewer", "prompt": "Your angle: bugs and failure modes." },
    { "name": "architect", "prompt": "Your angle: boundaries and long-term cost.", "model": "vllm/other-model" }
  ],
  "synthesizer": { "model": "vllm/some-model" },
  "seatTimeoutSeconds": 300,
  "synthTimeoutSeconds": 180
}
```

At least two seats; `model` is `provider/model` (the model id may itself contain slashes) and defaults to the session's model. A malformed file fails the call with the file name and the problem.

## Registration

The `config` hook registers the hidden `council-seat` and `council-synth` agents and the `/council` command, only if the user's config does not define them already. The seat agent's permission is `"*": "deny"` followed by `read`, `glob`, `grep` allowed, because the last matching rule wins.

## Tests

`tests/unit/council.test.mjs` drives the tool with a fake client: seats asked in parallel in the project directory, the synthesis input and report, a failing or empty seat, no answers, a failing synthesis, a hanging seat aborted at its timeout, config and model parsing, cancellation, and agent registration. `tests/integration/guard-plugins.test.mjs` runs it in a real opencode against a fake model and checks which tools each agent was actually offered, that the report reaches the calling model, and that the child sessions are gone afterwards.
