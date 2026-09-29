#!/usr/bin/env bash
# Publishes the current git HEAD as @kealthas-dev/opencode-toolkit on public
# npmjs.com. This isn't a real dependency for anything - it exists purely so
# the restricted target machine's internal npm mirror (download-only, see
# CLAUDE.md) can `npm pack @kealthas-dev/opencode-toolkit@<version>` instead
# of the current GitHub-Release-zip transfer.
#
# Publishes from a `git archive` export into a clean temp dir, not the
# working directory - so untracked files (a real mcp-servers/*/.env someone happens
# to have sitting around, scratch output, etc.) can never end up in the
# published tarball regardless of local .gitignore state. This also sidesteps
# npm's default packing rule of falling back to .gitignore when there's no
# files/.npmignore, which would otherwise silently drop
# docs/opencode-docs-reference/ and deploy/models-dev-snapshot.json - both
# intentionally gitignored-but-tracked and both things the offline machine
# actually needs.
#
# Requires you to already be logged in (`npm login`) with publish rights on
# the @kealthas-dev scope. Bump the version in package.json and commit that
# before running this.
#
# Usage: ./scripts/publish-npm.sh [extra npm publish flags, e.g. --otp=123456 --dry-run]

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree has uncommitted changes - commit or stash before publishing" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

git archive HEAD | tar -x -C "$tmp_dir"

echo "Publishing $(node -p "require('./package.json').name")@$(node -p "require('./package.json').version") from clean snapshot at $tmp_dir"
(cd "$tmp_dir" && npm publish --access public "$@")
