#!/usr/bin/env bash
# Rebuilds vendor/OpenJDK21U-jre_x64_windows_hotspot_*.zip from Eclipse
# Temurin's own official releases (github.com/adoptium/temurin21-binaries).
# Run this on a machine with real internet access (not the offline target
# machine - see the root CLAUDE.md/SETUP.md) whenever the vendored version
# needs to be refreshed.
#
# This vendors a JRE, not a full JDK: java-lsp/spring-lsp only need a java
# to *launch* jdtls/spring-boot-language-server with (both embed their own
# compiler, neither shells out to javac - verified live by running both
# packages' real test suites against a JRE-only java, all tests passing
# unchanged). A full Windows x64 JDK zip is ~195MB, over GitHub's 100MB
# per-file limit; the JRE is ~47MB, comfortably under it - same size class
# as mcp-servers/java-lsp's own vendored jdtls tarball.
#
# Lives at the repo root (not under mcp-servers/java-lsp or .../spring-lsp)
# because it's a shared dependency of both, and because the whole point is
# to ride along with the root @kealthas-dev/opencode-toolkit package (see
# docs/npm-publishing.md) - the one thing that already reaches the offline
# target machine as a plain extracted directory (SETUP.md step 0's
# $SRC_DIR), unlike java-lsp/spring-lsp themselves which install from their
# own separately-published npm packages. See SETUP.md step 8 for how it's
# actually used there.
#
# Usage: ./fetch-jdk.sh [major-version]
# Defaults to 21 (java-lsp/spring-lsp's shared minimum). Always resolves
# Windows x64 JRE, hotspot, "latest" for that major version via Adoptium's
# own API (api.adoptium.net) - no separate url/sha256 args, unlike
# fetch-jdtls.sh, since Adoptium's API already returns a checksum alongside
# the download link in one response.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MAJOR="${1:-21}"
API_URL="https://api.adoptium.net/v3/assets/latest/${MAJOR}/hotspot?os=windows&architecture=x64&image_type=jre"

echo "Resolving latest Temurin $MAJOR JRE (windows/x64) via Adoptium's API..." >&2
read -r URL SHA256 <<< "$(curl -sSL --max-time 30 "$API_URL" | python3 -c "
import json, sys
d = json.load(sys.stdin)[0]['binary']['package']
print(d['link'], d['checksum'])
")"
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
rm -f vendor/OpenJDK${MAJOR}U-jre_x64_windows_hotspot_*.zip
cp "$WORK_DIR/$OUT_NAME" "vendor/$OUT_NAME"
echo "Wrote vendor/$OUT_NAME ($(du -h "vendor/$OUT_NAME" | cut -f1)), sha256 verified." >&2
echo "SETUP.md step 8 discovers this by the OpenJDK<major>U-jre_x64_windows_hotspot_*.zip glob - nothing else to update." >&2
