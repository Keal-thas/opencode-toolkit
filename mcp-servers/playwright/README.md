# playwright mcp server

Like `mcp-servers/redis/`, there's no server code in this directory — this is the official upstream [`microsoft/playwright-mcp`](https://github.com/microsoft/playwright-mcp) package (npm `@playwright/mcp`), used unmodified. This directory just holds the deployment notes.

## Why the official package

Browser automation (navigation, clicking, form-filling, screenshots, accessibility-tree reads) is exactly the kind of large, already-solved tool surface `mcp-servers/redis/README.md`'s reasoning applies to: hand-rolling and re-verifying our own navigate/click/screenshot tools would be a lot of surface for no benefit over the actively-maintained upstream package.

## Wired as `type: "local"`, not `type: "remote"`

Same shape as `redis`/`memory` — opencode spawns and owns the process over stdio, not a persistent HTTP server we run ourselves:

```json
"mcp": {
  "playwright": {
    "type": "local",
    "command": ["npx", "@playwright/mcp@latest"],
    "enabled": true
  }
}
```

## Logging into a page before automating it

The package itself has no read-only/write-only split to enforce (unlike `redis`/`mysql`/`oracle`) — it drives a real browser as whatever account is logged into it. Two ways to hand it an already-authenticated session, both documented in the upstream README:

- **`--storage-state <path-to-json>`** — export cookies/localStorage from a real logged-in browser session once (Playwright's own `context.storageState()`), point the flag at that file. Preferred when the login rarely expires.
- **`--user-data-dir <path>`** — point at a persistent Chrome/Chromium profile directory instead of an ephemeral context; log in manually once through it, the profile keeps the session across runs. Preferred for logins that expire often (SSO, short-lived tokens) since there's nothing to re-export.

Either way, whatever file/directory holds the session state is a credential and must not be committed — keep it outside the repo or gitignored, same as `docker/.env`-style secrets.

## Status

Not yet wired into `deploy/opencode.json.example` or exercised against a real target — added on request, pending Franco actually driving a login-gated internal page with it.
