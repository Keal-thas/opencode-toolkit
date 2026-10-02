# system-prompt-tools

Dumps the fully-assembled system prompt that opencode actually sends to the model — every block, including opencode's own `<env>` block — to `~/.local/share/opencode/last-system-prompt.txt` on every request. It is the only way to confirm that `deploy/system-prompt.txt` really reaches the real model, because opencode offers no other view of what gets sent.

- Package: `@kealthas-dev/opencode-system-prompt-tools`, source `system-prompt-tools.ts`, hook `experimental.chat.system.transform`.
- Enabled by default in `deploy/opencode.json.example`. Install and verify steps: SETUP.md step 4.
- Each request overwrites the file, so it always reflects the latest request.
- Editing the `.ts` only takes effect once a new version is published; opencode installs plugins from npm by bare package name (mechanism and gotchas: `docker/notes.md`, "Plugin loading").

Tests: `tests/unit/system-prompt-tools.test.mjs` (dump content and header format, overwrite-not-append).
