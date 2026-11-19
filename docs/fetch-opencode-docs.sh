#!/usr/bin/env bash
# Fetches the top-level English opencode docs pages (upstream
# anomalyco/opencode, dev branch, services/site/src/docs/v1/content/) into
# docs/opencode-docs-reference/. Committed to git on purpose: the actual
# target machine has no internet access at all, so this travels with the
# repo in the zip transfer, and whoever is deploying or troubleshooting
# there can read the real docs instead of opencode.ai/docs.
#
# The directory IS listed in .gitignore, but that's only to keep
# ripgrep-based tools (grep/glob, in both Claude Code and opencode) from
# sweeping these long pages into unrelated broad searches - it does not
# untrack anything already committed. If this script ever adds a
# genuinely new page (not just updating an existing one), `git add`
# needs the `-f` flag for it, since gitignored paths don't show up as
# untracked automatically.
#
# Only the top-level English .mdx files - the API also lists ~17 locale
# subdirectories (ar/, de/, zh-cn/, ...) alongside them; skipped on
# purpose, English-only mirror.
#
# Usage: ./docs/fetch-opencode-docs.sh
# Needs: curl, python3 (both already assumed elsewhere in this repo).

set -euo pipefail

REPO="anomalyco/opencode"
BRANCH="dev"
# The v1 docs, which match the opencode 1.x this repo targets (docker/.env).
# Upstream also has an unversioned docs tree next to it for the next major
# version, with different pages and a rewritten plugin API.
DOC_PATH="services/site/src/docs/v1/content"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/opencode-docs-reference"

mkdir -p "$OUT_DIR"

api_url="https://api.github.com/repos/${REPO}/contents/${DOC_PATH}?ref=${BRANCH}"
listing=$(curl -sf "$api_url")

error=$(echo "$listing" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d.get('message', '') if isinstance(d, dict) else '')
")
if [[ -n "$error" ]]; then
  echo "GitHub API error: $error" >&2
  exit 1
fi

files=$(echo "$listing" | python3 -c "
import json, sys
for item in json.load(sys.stdin):
    if item['type'] == 'file':
        print(item['name'] + '\t' + item['download_url'])
")

count=0
while IFS=$'\t' read -r name url; do
  [[ -z "$name" ]] && continue
  curl -sf "$url" -o "$OUT_DIR/$name"
  echo "[fetched] $name"
  count=$((count + 1))
done <<< "$files"

echo "Done: $count files into $OUT_DIR"
