# plugins

opencode plugins, one npm package each (`@kealthas-dev/opencode-<name>`). To use one, put its bare package name in `opencode.json`'s `plugin` array; opencode installs it from npm itself (mechanism and gotchas: `docker/notes.md`, "Plugin loading"). Each directory's README has the details.

This table is the one list of plugins; other docs link here instead of repeating it.

| Plugin | What it does | In `deploy/opencode.json.example` | Published |
|---|---|---|---|
| [`system-prompt-tools`](system-prompt-tools/README.md) | dumps the system prompt actually sent, to confirm the override took effect | enabled | yes |
| [`hook-logger`](hook-logger/README.md) | logs every hook event as JSONL | enabled | yes |
| [`llm-review-gate`](llm-review-gate/README.md) | LLM safety review before each `bash` call | commented out (opt-in) | yes |
| [`gitbash-edit-path-fix`](gitbash-edit-path-fix/README.md) | fixes Git-Bash paths in the `edit` tool on Windows | no | not yet |
| [`verify-session`](verify-session/README.md) | `/verify` starts an independent review session | no | not yet |

"Published" means included in `release.yml`'s package loop ([docs/npm-publishing.md](../docs/npm-publishing.md)).
