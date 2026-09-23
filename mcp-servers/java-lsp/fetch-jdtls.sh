#!/usr/bin/env bash
# Rebuilds vendor/jdt-language-server-*.tar.gz from Eclipse's own official
# milestone builds (https://download.eclipse.org/jdtls/milestones/). Run
# this on a machine with real internet access (not the offline target
# machine - see the root CLAUDE.md/SETUP.md) whenever the vendored version
# needs to be refreshed.
#
# jdtls (eclipse-jdtls/eclipse.jdt.ls, EPL-2.0) doesn't expose a simple
# machine-readable "latest version" API of its own - this uses Homebrew's
# own jdtls formula (already the tool this repo's dev-verification used -
# see README.md's JDK version section) to resolve the current version and
# its official download URL + checksum, the same source `brew install
# jdtls` itself would use.
#
# Usage: ./fetch-jdtls.sh [version] [url] [sha256]
# With no arguments, resolves the current version via `brew info jdtls`
# (needs Homebrew installed). Pass all three explicitly to skip Homebrew
# entirely, e.g. to pin a specific milestone from
# https://download.eclipse.org/jdtls/milestones/ by hand.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

VERSION="${1:-}"
URL="${2:-}"
SHA256="${3:-}"

if [ -z "$VERSION" ] || [ -z "$URL" ] || [ -z "$SHA256" ]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "No Homebrew found and version/url/sha256 not all given explicitly - see this script's usage comment." >&2
    exit 1
  fi
  echo "Resolving jdtls's current version via Homebrew's own formula..." >&2
  read -r VERSION URL SHA256 <<< "$(brew info --json=v2 jdtls | python3 -c "
import json, sys
f = json.load(sys.stdin)['formulae'][0]
u = f['urls']['stable']
print(f['versions']['stable'], u['url'], u['checksum'])
")"
fi
echo "Using jdtls $VERSION" >&2
echo "  $URL" >&2

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

OUT_NAME=$(basename "$URL")
echo "Downloading $URL ..." >&2
curl -sSL --max-time 300 --retry 3 -w "http_code=%{http_code} size=%{size_download}\n" \
  -o "$WORK_DIR/$OUT_NAME" "$URL"

ACTUAL_SHA256=$(shasum -a 256 "$WORK_DIR/$OUT_NAME" | cut -d' ' -f1)
if [ "$ACTUAL_SHA256" != "$SHA256" ]; then
  echo "Checksum mismatch: expected $SHA256, got $ACTUAL_SHA256 - aborting, not touching vendor/." >&2
  exit 1
fi

mkdir -p vendor
rm -f vendor/jdt-language-server-*.tar.gz
cp "$WORK_DIR/$OUT_NAME" "vendor/$OUT_NAME"
echo "Wrote vendor/$OUT_NAME ($(du -h "vendor/$OUT_NAME" | cut -f1)), sha256 verified." >&2
echo "server.ts discovers the version from this tarball's filename automatically (see resolveJdtlsCommand() in src/server.ts) - nothing else to update." >&2
