# playwright mcp server

No server code in this directory, same stance as `mcp-servers/redis/` — this is the official [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) package, used unmodified. This directory just holds the deployment notes. See `mcp-servers/TODO.md`'s Playwright entry for the discussion this README distills.

## Why the official package, not a hand-rolled one

Browser automation isn't a small, generic surface like `mcp-servers/mysql/`'s one passthrough SQL tool — it's ~90 tools across navigation, input, network mocking, storage, tracing, and vision-based interaction (see `@playwright/mcp`'s own README for the full list). Hand-rolling and re-verifying that would be a lot of surface for no benefit over the maintained upstream package.

## Install

```
npm install -g @playwright/mcp
```

`@playwright/mcp` depends on `playwright` (not `playwright-core`), whose `postinstall` hook auto-downloads a bundled Chromium from Microsoft's own CDN (`playwright.azureedge.net`/`-akamai`) — a different download path from the npm/PyPI mirrors already confirmed reachable from the offline Windows target machine (`docs/deployment-environment.md`). Confirmed on the target machine that `ignore-scripts=false`, so the `postinstall` hook does run; whether the CDN itself is reachable from there is still unconfirmed.

No admin/root needed for any of this, on either the Windows target or the docker sandbox — installing to a user-level npm prefix and downloading a browser into a per-user cache directory doesn't touch anything privileged. `--no-sandbox` (see below) is unrelated to *installing* — it's a Chromium *runtime* sandbox flag only relevant if the process were run as root, which it isn't here.

## Browser selection: skip the CDN download on the real target

`--browser=msedge` drives the Windows target machine's already-installed system Edge over CDP instead of downloading Playwright's own bundled Chromium — Edge ships with Windows, so this sidesteps the CDN-reachability question above entirely for that machine. `--browser=chrome` is the same idea if Chrome happens to be installed instead.

The `docker/` sandbox is Linux, so neither `msedge` nor `chrome` applies there — local dev/testing in the sandbox should use the default bundled Chromium (the one the `postinstall` hook downloads, or `npx playwright install chromium` if it's missing), no `--browser` flag needed. This is a real, expected difference between the sandbox config and the real deployment target, same shape as `java-lsp`/`spring-lsp`'s sandbox-vs-target JDK gap (see `mcp-servers/TODO.md`'s entry for those).

If a target machine has neither Edge nor Chrome and the CDN is unreachable, the fallback is copying an already-downloaded `ms-playwright` cache directory from another machine and pointing `PLAYWRIGHT_BROWSERS_PATH` at it — no re-download needed, same vendoring instinct as `java-lsp`'s vendored jdtls tarball, just not committed to the repo (a browser binary is a much bigger, much more frequently-updated artifact than a language server).

## No runtime hot-switch between browsers

`--browser` is read once at process startup; there's no tool call that changes it mid-session (`browser_get_config` only reports the resolved config back, it doesn't let you set it). Switching Edge ↔ Chrome means restarting the MCP server process with a different `--browser` value. Deliberately not worked around by running two permanently-resident instances on different ports — the restart cost is small enough on a single-user setup that the extra permanently-running browser process isn't worth it.

## Permission split: opencode's `permission` config, not a package flag

`@playwright/mcp` has no built-in "read-only mode" flag — all capability groups (`--caps=core,tabs,config,network,storage,devtools,vision,pdf,testing`) stay enabled, and the read/write split is enforced one layer up, in opencode's own `permission` config, matched against the tool names directly (wildcard patterns work the same for MCP tools as built-ins — `docs/opencode-docs-reference/agents.mdx`'s note on this). Read-only tools (snapshot, screenshot, console messages, find, get_config, network reads, route_list, cookie/storage reads, storage_state, pdf_save, generate_locator) are `allow`; everything else — navigation, clicks, typing, `evaluate`/`run_code_unsafe`, form fills, cookie/storage writes, tabs — falls through to a trailing `"playwright_*": "ask"` catch-all. Rule order matters: opencode uses last-matching-rule-wins, so the specific `allow` entries have to come before the catch-all, not after.

This mirrors `mcp-servers/redis/`'s "the safety boundary lives one layer below the tool surface, not in the package itself" shape — there it's a Redis ACL user, here it's the opencode permission config — just with opencode itself as that layer instead of the target system, since there's no ACL concept to borrow from a browser.

## Other launch flags decided

- **`--isolated`** — in-memory profile, no persisted login state across sessions. A specific test account's state can still be loaded explicitly per run via `--storage-state` when a scenario actually needs to be logged in, rather than letting login state accumulate implicitly on disk across runs.
- **`--shared-browser-context`** left off (default) — that flag is for multiple HTTP clients sharing one browser over a remote HTTP/SSE deployment. Irrelevant here: `type: "local"` stdio means one opencode session already owns one MCP process exclusively.
- **`--secrets`** not configured — only worth pointing at a dotenv file once a specific intranet target that requires login is actually in scope, to redact those values out of tool output. Nothing to point it at yet.
- **`--output-dir` worth setting explicitly** — observed while running the sandbox test: without it, `@playwright/mcp` still writes scratch artifacts (page snapshot YAML files, one per `browser_snapshot` call) into a relative `.playwright-mcp/` directory under whatever the process's working directory happens to be, not just returning them in the tool response. Harmless in the sandbox (gitignored, deleted after the test run — see `.gitignore`), but on a real deployment this should point at a real scratch directory (with `--output-max-size` to cap it), not be left to land wherever opencode happens to be invoked from.
- **`--image-responses omit`** (not the default `allow`) — `browser_snapshot`'s text accessibility tree covers most "what's on the page" needs via the already-`allow`ed read tools, so auto-attaching a screenshot image to every response would burn context for little benefit. Call `browser_take_screenshot` explicitly on the rare occasion a visual check is actually needed.
- **Scope is localhost/intranet targets only** — the usual headless-fingerprint/bot-detection concern for public sites (`navigator.webdriver`, headless UA string, CDP artifacts tripping Cloudflare/reCAPTCHA-style risk engines) doesn't apply here; not a design constraint this deployment needs to work around.

## Wired as `type: "local"`

Same shape as `redis` — `@playwright/mcp` is stdio-only by default (it only gains HTTP/SSE transport with an explicit `--host`/`--port`, not needed here), so opencode spawns and owns the process directly. `command` invokes the globally-installed bin directly (`playwright-mcp` — see Install above), the same pattern the `memory` MCP server entry already uses, rather than `npx`:

```json
"playwright": {
  "type": "local",
  "command": [
    "playwright-mcp",
    "--browser", "msedge",
    "--headless",
    "--isolated",
    "--caps", "core,tabs,config,network,storage,devtools,vision,pdf,testing",
    "--image-responses", "omit"
  ],
  "enabled": true
}
```

`--headless` — not discussed until it surfaced as a real requirement while writing the docker sandbox test (headed mode has no display to attach to there, and this deployment's actual use case is an unattended agent driving the browser, not a human watching it), so headless is the right default for the real Windows target too, not just the sandbox. Defaults to headed mode if omitted.

Plus, in the top-level `permission` block:

```json
"playwright_browser_snapshot": "allow",
"playwright_browser_take_screenshot": "allow",
"playwright_browser_console_messages": "allow",
"playwright_browser_find": "allow",
"playwright_browser_get_config": "allow",
"playwright_browser_network_request*": "allow",
"playwright_browser_route_list": "allow",
"playwright_browser_cookie_get": "allow",
"playwright_browser_cookie_list": "allow",
"playwright_browser_*storage_get": "allow",
"playwright_browser_*storage_list": "allow",
"playwright_browser_storage_state": "allow",
"playwright_browser_pdf_save": "allow",
"playwright_browser_generate_locator": "allow",
"playwright_*": "ask"
```

Not yet added to `deploy/opencode.json.example` — deliberately held back until this gets tested end-to-end alongside the rest of the deployment, same as any other change there.

## Status

**Verified in the docker sandbox, against a real headless Chromium — not yet against the real Windows target.** `tests/integration/mcp-playwright/playwright.test.mjs` spawns the real `@playwright/mcp` binary (`playwright-mcp`, globally installed in `docker/Dockerfile`) and drives it with a real `@modelcontextprotocol/sdk` `Client` against a fixture page served by the test itself (no external network dependency at test time): tool listing (spot-checks the read/write split documented above actually matches the real tool names, catching drift), a real `browser_navigate` + `browser_snapshot` round trip, a real `browser_click` that changes real DOM state (confirmed independently via `browser_evaluate`, not just trusting the click tool's own success report), `browser_console_messages` capturing a real `console.log` triggered by that click, and `--allowed-origins` actually blocking a disallowed navigation (not just documented as a caveat — observed the navigation itself come back as an error). All 5 pass. Wired into `tests/run-in-container.sh`, so it's part of `./tests/run-all.sh` going forward.

The sandbox's Linux base image can't exercise the `msedge`/`chrome` channel path that matters for the actual Windows target — the test above uses `--browser chromium` (the bundled default), a different code path from what production will actually use — so the CDN-reachability and `msedge`/`chrome` channel-selection questions from the Install/Browser-selection sections above are still open, and `opencode.json`'s tolerance for an unrecognized `"#"`-keyed comment field is still unconfirmed. Not yet added to `deploy/opencode.json.example` for the same reason.

**Two real bugs found while verifying this, not assumed from the README:**

1. **`@playwright/mcp`'s bundled `playwright-core` dependency pins a different Chromium revision than a plain `npx playwright install chromium` downloads.** Confirmed live: `docker/Dockerfile` originally ran only `playwright install --with-deps chromium`, which fetched revision 1243 — but the installed `@playwright/mcp` then failed every browser tool with `Error: Browser "chrome-for-testing" is not installed; expected executable at .../chromium-1246/...`. Fix: also run `npx @playwright/mcp install-browser chrome-for-testing` (the exact command the error message itself names) at build time, which fetches the actual matching revision (1246) alongside the first one. Both installs are needed — `playwright install --with-deps` is what pulls in the Linux system libraries (`libnss3`, `libatk1.0-0`, `libgbm1`, etc.) Chromium needs and that `@playwright/mcp install-browser` alone does not install; `@playwright/mcp install-browser` is what gets the exact revision `@playwright/mcp` itself will actually look for at runtime. See `docker/Dockerfile`'s comment on this step.
2. **`@modelcontextprotocol/sdk`'s `StdioClientTransport` does not inherit the parent Node process's environment by default.** `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` was visibly set in the shell (confirmed via `docker/dev.sh run --rm opencode-dev bash -c 'echo $PLAYWRIGHT_BROWSERS_PATH'`), but the spawned `playwright-mcp` subprocess still looked in the default `~/.cache/ms-playwright` (empty in this image) until the test explicitly passed `env: process.env` to `StdioClientTransport`'s constructor — the same thing `tests/integration/mcp-redis/redis.test.mjs` already does for its own env vars, but easy to miss since it's silent (no error about a missing env var, just a confusing "browser not installed" failure that looks like an install problem, not an env-passing one).
