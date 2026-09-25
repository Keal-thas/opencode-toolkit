# Free-tier limits: GitHub, npm, Docker Hub

What a free account on each platform actually caps, for this repo's real usage: a public GitHub repo (`Keal-thas/opencode-toolkit`) publishing several npm packages under public scopes, plus a `docker/` sandbox that pulls `node:22-bookworm` but pushes nothing to Docker Hub. Numbers below are current as of September 2026 — re-check before relying on anything here past a year or so, especially the Docker Hub pull-rate history (it has already changed direction twice).

## GitHub

### Actions

| Limit | Value | Applies to | Source |
|---|---|---|---|
| Included minutes/month | 2,000 | Free plan, private repos | [About billing for GitHub Actions](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions) |
| Minutes for public repos | Unlimited, free | Standard GitHub-hosted runners, any plan | same |
| Included artifact storage | 500 MB | Free plan | same |
| Included cache storage | 10 GB per repo | Free plan | same |
| Per-minute overage rate | Linux $0.006 / Windows $0.010 / macOS $0.062 | Private repos beyond included minutes | same |
| Job execution time | 6 hours | GitHub-hosted runner | [Actions limits](https://docs.github.com/en/actions/reference/limits) |
| Job execution time | 5 days | Self-hosted runner | same |
| Job queue time before auto-cancel | 24 hours | Self-hosted runner | same |
| Workflow run time | 35 days | Any runner; run is cancelled past this | same |
| Concurrent jobs | 20 | Free plan (total, across standard runners) | same |
| Concurrent jobs | 40 / 60 / 500 | Pro / Team / Enterprise respectively | same |
| Matrix jobs per workflow run | 256 | All plans | same |
| Workflow file size | 500 KB | Per file in `.github/workflows/`, or the run doesn't trigger | same |
| Workflow re-runs | 50 | All plans | same |

### REST API rate limits

| Limit | Value | Applies to | Source |
|---|---|---|---|
| Unauthenticated requests | 60/hour, per IP | Anonymous REST calls, HTTPS clone, `raw.githubusercontent.com` | [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| Authenticated (PAT/OAuth/user) | 5,000/hour | Free/Pro/Team personal accounts | same |
| `GITHUB_TOKEN` in Actions | 1,000/hour per repository | Any plan | same |
| Secondary limit: content-generating requests | 80/min, 500/hour | All (e.g. issue/PR/comment creation) | same |

The unauthenticated 60/hour figure was tightened from a looser historical limit on 2025-05-08 in response to scraping load ([changelog](https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/)) — it also covers unauthenticated `git clone` over HTTPS and raw file downloads, not just API calls.

### Repository / Git / Packages / Pages

| Limit | Value | Source |
|---|---|---|
| Recommended repo size | <1 GB ideal, <5 GB strongly recommended | [About large files on GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) |
| File size hard block | 100 MiB (push rejected, needs Git LFS) | same |
| On-disk `.git` size (harder technical ceiling, separate from the soft repo-size guideline above) | 10 GB | [Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits) |
| Git LFS storage + bandwidth included | 10 GiB each, metered beyond that (pre-paid packs removed) | [About Git LFS](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage) |
| GitHub Packages storage | Free, unlimited | Public packages — [Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages) |
| GitHub Packages storage/transfer | 500 MB / 1 GB/month | Private, free personal plan | same |
| GitHub Pages bandwidth/builds | 100 GB/month, 10 builds/hour (both soft) | All plans | [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |

GitHub Free (personal or org) also gives **unlimited public and unlimited private repos**, with no collaborator-count cap on either — private repos just get a reduced feature set (no required reviewers, less auditing), not fewer repos or people.

### What this means for opencode-toolkit

Actions: `.github/workflows/`'s one-off `workflow_dispatch` jobs run on a public repo, so they're free regardless of runner OS or minute count — none of the Free-plan minute/storage figures ever apply. The 6-hour/35-day/20-concurrent/256-matrix/500KB-file ceilings are all far above anything a one-off dispatch job approaches — not worth instrumenting or watching. Repo/Git LFS/Pages/Packages: not in use and nowhere near any threshold (source + docs + small vendored tarballs, no LFS, no Pages; npm packages publish to npmjs.com, not GitHub Packages).

## npm

| Item | Current policy | Source |
|---|---|---|
| Publishing public packages | Free, uncapped in count | [About packages and modules](https://docs.npmjs.com/about-packages-and-modules/) |
| Private packages on free personal plan | Not available — requires a paid user ($7/mo) or org plan | [Upgrading to a paid plan](https://docs.npmjs.com/upgrading-to-a-paid-user-account-plan/) |
| Tarball size limit | No official documented number. Registry rejects oversized publishes with HTTP 413 | This repo's own history (below) — no npm docs page states a hard figure |
| Unpublish within 72h of first publish | Allowed, if nothing else in the registry depends on it | [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/) |
| Republish after full unpublish | Blocked for 24 hours on the same name | same |
| Unpublish beyond 72h | Only if nothing depends on it; npm support handles exceptions | same |
| 2FA for publishing | **All packages** now require either account 2FA or a granular token explicitly configured with a 2FA bypass | [Requiring 2FA for publishing](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/) (superseded the old top-100/top-500/1M-download tiered rollout) |
| Bypass-2FA token restrictions | Since 2026-07-31 these tokens can no longer do account-identity actions (create/delete tokens, change access, add maintainers); direct-publish via these tokens is slated for removal January 2027 | [npm publish-time malware scanning](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/) |
| Staged publishing (`npm stage publish`) | Opt-in, GA since npm CLI 11.15.0 (May 2026) — adds a human 2FA-approval checkpoint between build and public availability. Plain `npm publish` still works unless a config is explicitly locked to stage-only | [Staged publishing](https://docs.npmjs.com/staged-publishing/), [Trusted publishing](https://docs.npmjs.com/trusted-publishers/) |
| Publish-time malware scan delay | ~5 min typical, up to 15 min at peak | [GitHub Blog, 2026-07-28](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/) |
| Registry rate limits for manual/occasional publishing | No official numeric policy published | Not documented anywhere on docs.npmjs.com |

### What this means for opencode-toolkit

Tarball size is the one real thing worth watching: this repo already hit the undocumented ceiling once (root package tarball at 333.5 MB → HTTP 413), fixed in [#40](https://github.com/Keal-thas/opencode-toolkit/pull/40) by excluding `mcp-servers/{java-lsp,spring-lsp}/vendor/*.tar.gz` from the root `.npmignore` (they ship in their own packages anyway). No hard number exists to budget against — the practical rule from this repo's own data point is "stay well under ~300 MB packed," not any officially quoted figure. 2FA/staged publishing: not a blocker — `scripts/publish-npm.sh`/`release.yml` publish via npm Trusted Publishing (OIDC, `id-token: write`), a separate mechanism unaffected by the account-2FA mandate; the account-2FA requirement only bites during a brand-new package's one-time manual `npm login && npm publish` bootstrap (already how `docs/npm-publishing.md` describes onboarding a package). Private packages and unpublish policy: irrelevant/unchanged — every package here is public on purpose, and each `v*` tag publish is already treated as permanent/append-only.

## Docker Hub

| Limit | Value | Applies to | Source |
|---|---|---|---|
| Anonymous pull rate | 100 pulls / 6 hours, per IPv4 address or IPv6 /64 | Unauthenticated | [Docker Hub usage and limits](https://docs.docker.com/docker-hub/usage/), [Pull usage and limits](https://docs.docker.com/docker-hub/usage/pulls/) |
| Free authenticated pull rate | 200 pulls / 6 hours | Docker Personal (free) account | same |
| Paid pull rate | Unlimited (fair-use) | Pro/Team/Business | same |
| Private repositories | 1 | Docker Personal (free) | [Docker Hub usage and limits](https://docs.docker.com/docker-hub/usage/) |
| Public repositories | Unlimited | All account tiers | same |
| Inactive-image deletion | **Not currently in effect.** The 2020-announced "delete images inactive >6 months on free accounts" policy was postponed and never enforced; the current usage-and-limits page makes no mention of any retention/expiry policy | [HN thread on the delay](https://news.ycombinator.com/item?id=24922938) + absence from current docs |
| Storage-based billing | Explicitly **indefinitely delayed**, not introduced; Docker committed to 6 months' notice before ever introducing it | [Revisiting Docker Hub Policies](https://www.docker.com/blog/revisiting-docker-hub-policies-prioritizing-developer-experience/) (2025-02-21, updated 2025-04-08) |

**A stricter set of numbers ("10 pulls/hr unauthenticated, 100 pulls/hr authenticated") is still floating around, including on `docker.com/pricing/faq`.** That matches a policy Docker announced for 2025-04-01 and then explicitly walked back before it took effect — their own blog post states verbatim: *"We did not enforce the Docker Hub rate limit changes previously scheduled for April 1, 2025. The current limits — 100 pulls per 6 hours for unauthenticated users and 200 pulls per 6 hours for Docker Personal users — will remain in place."* Treat the pricing FAQ's hourly figures as stale copy that was never updated after the walk-back; the dedicated usage-and-limits reference page agrees with the 100/200-per-6-hours figures above.

### What this means for opencode-toolkit

Irrelevant today: `docker/` only *pulls* `node:22-bookworm` as a dev-sandbox base image and never pushes to Docker Hub. A single dev/test sandbox pulling one base image (mostly layer-cache hits after the first pull) across `docker/dev.sh` sessions in multiple worktrees is nowhere near 100–200 pulls/6h. Would only start to matter if this repo ever pushes its own prebuilt image to Docker Hub to speed up `docker/dev.sh` cold starts — at that point the 1-private-repo/free-tier cap and the pull-rate ceiling would matter for concurrent worktrees sharing one IP (a public image doesn't get unlimited pulls on a free account — only a paid-plan *puller* gets unlimited, regardless of whether the image itself is public).
