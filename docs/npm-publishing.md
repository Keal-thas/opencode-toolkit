# Whole-repo npm publishing

Linked from [CLAUDE.md](../CLAUDE.md)'s "Where things live".

## Why the root package exists

The root `package.json` packages the entire git-tracked tree as `@kealthas-dev/opencode-toolkit` on public npmjs.com — not a real dependency for anything, purely a second download channel alongside the `v*`-tag GitHub Release zip (`.github/workflows/release.yml`). The restricted machine's internal npm mirror can then fetch it with `npm pack @kealthas-dev/opencode-toolkit@<version>`. `license: "UNLICENSED"` because public/downloadable here is a transfer mechanism, not an invitation for outside use.

`scripts/publish-npm.sh` exports the current `HEAD` with `git archive` into a clean temp dir before publishing, avoiding sweeping local untracked files into the tarball. Keep the intentionally-empty root `.npmignore`: its presence stops npm from falling back to `.gitignore` and dropping gitignored-but-tracked payloads such as `docs/opencode-docs-reference/` and `deploy/models-dev-snapshot.json`.

## One shared version number for every package

**Pushing a `v*` tag is the single release trigger for every npm package in this repo** — root, `plugins/*` x3, `mcp-servers/oracle`, `mcp-servers/loki`, `mcp-servers/java-lsp`, `mcp-servers/spring-lsp` (7 packages total). `release.yml` loops over all of them:

- sets each one's version from the tag (`npm pkg set version=...`), skipping any already published at that exact version so a workflow re-run is safe
- builds it first if its `package.json` has a `build` script (all four `mcp-servers/*` packages — `npm ci && npm run build` before `npm publish`, since the published tarball is `dist/` [+ `vendor/*.tar.gz` for `java-lsp`/`spring-lsp`], not source)
- publishes via npm Trusted Publishing (OIDC, `id-token: write`, no stored token)

None of the individual `package.json` `version` fields are meaningful on their own — Franco decided against independent per-package versioning (bumping only the packages that actually changed) specifically to avoid tracking N different version numbers across N files. A release bumps every package together, even ones with no code change, which is the accepted tradeoff.

The workflow must publish before building the GitHub Release zip, so the zip artifact can't get swept into the npm tarball.

## Bootstrapping a brand-new package

A package's *first-ever* publish can't go through this workflow — npm Trusted Publishing is configured on an existing package's Settings page on npmjs.com, so the package has to exist first via a real account login (`npm login` + `npm publish` by hand) before that binding can even be created. Every package listed above has already been through that bootstrap once.
