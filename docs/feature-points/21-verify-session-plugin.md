# verify-session.ts plugin

`/verify <what the change should do>` starts a brand-new top-level opencode session that independently reviews the working tree, then switches the TUI to it. It is a plugin rather than a `subtask: true` command because a subtask is a child session with restricted permissions; a top-level session runs as the normal agent with its full tool permissions and can run tests itself.

**Context handed to the new session** (the reviewer must not inherit the implementer's blind spots):
- the claim (`$ARGUMENTS`), treated as a hypothesis to falsify;
- the calling session's *user* messages only (all of them within a ~16k-char budget; if over, the first 2 plus the newest that fit, gap marked) as the spec, never its assistant messages or reasoning;
- `git status --short`, `git diff HEAD` (capped) and `git log --oneline -10`, gathered by the plugin itself so nothing is relayed second-hand.

It replies with `VERDICT: PASS | FAIL | UNVERIFIABLE` plus per-requirement evidence.

**Mechanism:** the plugin's `config` hook registers the `verify` command; `command.execute.before` creates the session, fires `session.promptAsync` without awaiting, and POSTs `/tui/select-session` (the v1 client the plugin receives has no `tui.selectSession`). The originating session still gets one trivial model turn from the command's replaced template, since the hook cannot suppress it.

**Deployment:** own package at `plugins/verify-session/`. Opt-in: add `@kealthas-dev/opencode-verify-session` to `opencode.json`'s `plugin` array once published. Not yet added to `deploy/opencode.json.example`.

**Tested:** `tests/unit/verify-session.test.mjs` (command registration, top-level session with no `parentID`, prompt content incl. no assistant-message leak, `select-session` call, other commands ignored). Also run against a real `opencode serve` (1.18.33) in the docker sandbox: `/verify` produced a separate session that ran its own `python3` check. **Not verified:** the TUI actually switching to the new session (needs an interactive TUI).
