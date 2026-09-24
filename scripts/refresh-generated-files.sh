#!/usr/bin/env bash
# Manually re-runs every fetch-*.sh script for this repo's git-tracked
# generated/vendored artifacts (see docs/generated-files.md) and auto-commits
# any drift under a distinct bot identity, so `git log`/`git blame` clearly
# show it as a mechanical refresh rather than a hand-edit.
#
# Not wired into any git hook - these downloads (jdtls + spring-lsp vendor
# tarballs are 50-80MB, the models snapshot needs Docker) are too slow and
# too dependent on network/Docker/Homebrew to run on every commit or push.
# Run this by hand whenever you want to check for upstream drift, e.g. before
# cutting a release.
#
# Each fetch step "fails open": if a script itself can't run (no network, no
# Docker, no Homebrew, upstream API hiccup), that check is skipped with a
# warning rather than aborting the rest.
#
# Usage: ./scripts/refresh-generated-files.sh

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."

BOT_NAME="sync-bot"
BOT_EMAIL="sync-bot@localhost"
BODY="Auto-committed by scripts/refresh-generated-files.sh; see docs/generated-files.md."

refreshed=""
warned=""

check() {
  path="$1"
  script="$2"
  label="$3"
  subject="$4"

  echo "Checking $label ($script)..."
  if ! "$script" >/tmp/refresh-generated-files-fetch.log 2>&1; then
    echo "  could not refresh $label ($script failed) - skipping." >&2
    sed 's/^/    /' /tmp/refresh-generated-files-fetch.log >&2
    warned="1"
    return
  fi

  if git diff --quiet -- "$path" && [ -z "$(git status --porcelain -- "$path")" ]; then
    echo "  up to date"
    return
  fi

  git add -f -- "$path"
  if GIT_AUTHOR_NAME="$BOT_NAME" GIT_AUTHOR_EMAIL="$BOT_EMAIL" \
     GIT_COMMITTER_NAME="$BOT_NAME" GIT_COMMITTER_EMAIL="$BOT_EMAIL" \
     git commit -q -m "$subject" -m "$BODY" -- "$path"
  then
    sha=$(git rev-parse --short HEAD)
    echo "  was stale - auto-committed refresh as $sha ($subject)"
  else
    echo "  drifted but auto-commit failed - fix manually." >&2
  fi
  refreshed="$refreshed $label"
}

check "docs/opencode-docs-reference/" "docs/fetch-opencode-docs.sh" "opencode docs mirror" "chore(docs): refresh opencode docs mirror from upstream"
check "deploy/models-dev-snapshot.json" "deploy/fetch-models-snapshot.sh" "models.dev snapshot" "chore(deploy): refresh models.dev snapshot"
check "mcp-servers/java-lsp/vendor/" "mcp-servers/java-lsp/fetch-jdtls.sh" "jdtls vendor package" "chore(java-lsp): refresh vendored jdtls"
check "mcp-servers/spring-lsp/vendor/" "mcp-servers/spring-lsp/fetch-spring-boot-language-server.sh" "spring-boot-language-server vendor package" "chore(spring-lsp): refresh vendored spring-boot-language-server"

rm -f /tmp/refresh-generated-files-fetch.log

echo
if [ -n "$refreshed" ]; then
  echo "Refreshed:$refreshed (committed under '$BOT_NAME' - review with 'git show', then push when ready)."
fi
if [ -n "$warned" ]; then
  echo "Some checks were skipped (see warnings above)."
fi
if [ -z "$refreshed" ] && [ -z "$warned" ]; then
  echo "Everything up to date."
fi
