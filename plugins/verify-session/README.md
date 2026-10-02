# verify-session

`/verify <what the change should do>` starts a brand-new top-level opencode session that independently reviews the working tree, then switches the TUI to it. It is a plugin and not a `subtask: true` command because a subtask is a child session with restricted permissions; a top-level session runs as the normal agent with full tool permissions and can run tests itself. It answers `VERDICT: PASS | FAIL | UNVERIFIABLE` with evidence per requirement.

- Package: `@kealthas-dev/opencode-verify-session`, source `verify-session.ts`.
- Not yet published and not in `deploy/opencode.json.example`; see `TODO.md`. Until then it works as a hand-copied file in a plugins directory.

## What the new session is given

The reviewer must not inherit the implementer's blind spots, so it gets only:
- the claim (`$ARGUMENTS`), treated as a hypothesis to falsify;
- the calling session's user messages as the spec (within a ~16k-character budget: the first two plus the newest that fit, gap marked), and only the assistant's last text message as its completion report, labelled UNVERIFIED — never its tool calls or reasoning;
- `git status --short`, a diff against the fork point from master/main (capped) and the branch commits, collected by the plugin itself so nothing is relayed second-hand.

## Mechanism

The `config` hook registers the `verify` command. `command.execute.before` creates the session, fires `session.promptAsync` without awaiting, and POSTs `/tui/select-session` (the v1 client the plugin receives has no `tui.selectSession`). The originating session still spends one trivial model turn on the command's replaced template, since the hook cannot suppress it.

## Tests and limits

`tests/unit/verify-session.test.mjs` covers command registration, a top-level session with no `parentID`, prompt content (no assistant-message leak), the `select-session` call and other commands being ignored. A real `opencode serve` run produced a separate session that ran its own check. The TUI actually switching to the new session needs an interactive TUI and is unverified.
