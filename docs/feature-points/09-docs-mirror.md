# Local opencode docs mirror + fetch script

`docs/opencode-docs-reference/` is a committed local copy of upstream opencode's own `.mdx` docs pages, refreshed via `docs/fetch-opencode-docs.sh`, since the target machine has no internet to consult the live docs. `docs/sdk-vs-http-api.zh.md` is a separate research note.

**Tested:** `tests/unit/shell-syntax.test.mjs` runs `bash -n` on `fetch-opencode-docs.sh` (syntax only). The actual GitHub fetch isn't exercised in tests — it would hit the network on every test run for a docs-mirror refresh, not app logic.
