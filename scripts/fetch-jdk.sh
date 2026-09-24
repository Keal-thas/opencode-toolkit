#!/usr/bin/env bash
# Rebuilds vendor/OpenJDK21U-jdk_x64_windows_hotspot_*.zip.part-* from
# Eclipse Temurin's own official releases
# (github.com/adoptium/temurin21-binaries). Run this on a machine with real
# internet access (not the offline target machine - see the root
# CLAUDE.md/SETUP.md) whenever the vendored version needs to be refreshed.
#
# A full JDK, not a JRE: java-lsp/spring-lsp only strictly need a java to
# *launch* jdtls/spring-boot-language-server with (both embed their own
# compiler, neither shells out to javac - verified live by running both
# packages' real test suites against a JRE-only java, all tests passing
# unchanged) - but Franco asked for the full JDK vendored instead (chat,
# 2026-09-24), so this fetches image_type=jdk.
#
# A Windows x64 JDK 21 zip is ~195MB - over GitHub's 100MB per-file limit,
# unlike the ~47MB JRE this replaces. Rather than pull in Git LFS (a real
# workflow-file change: `git archive` - what scripts/publish-npm.sh's
# `git archive` step and the offline target machine's "Download ZIP" both
# rely on - does NOT resolve LFS pointers to real content without extra
# smudge-filter plumbing neither of those paths currently has), this script
# splits the downloaded zip into <100MB chunks with plain `split`, committed
# as ordinary git blobs. Reassemble with `cat ... > file.zip` before
# unzipping - see SETUP.md step 8.
#
# Usage: ./fetch-jdk.sh [major-version] [image-type]
# Defaults to 21 (java-lsp/spring-lsp's shared minimum) and jdk. Always
# resolves Windows x64, hotspot, "latest" for that major version via
# Adoptium's own API (api.adoptium.net) - no separate url/sha256 args,
# unlike fetch-jdtls.sh, since Adoptium's API already returns a checksum
# alongside the download link in one response.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MAJOR="${1:-21}"
IMAGE_TYPE="${2:-jdk}"
API_URL="https://api.adoptium.net/v3/assets/latest/${MAJOR}/hotspot?os=windows&architecture=x64&image_type=${IMAGE_TYPE}"

echo "Resolving latest Temurin $MAJOR $IMAGE_TYPE (windows/x64) via Adoptium's API..." >&2
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

FILE_SIZE=$(wc -c < "$WORK_DIR/$OUT_NAME")
mkdir -p vendor
rm -f "vendor/OpenJDK${MAJOR}U-${IMAGE_TYPE}_x64_windows_hotspot_"*.zip.part-*

if [ "$FILE_SIZE" -gt 94371840 ]; then  # 90 MiB - safety margin under GitHub's 100MB hard limit
  echo "$OUT_NAME is $(du -h "$WORK_DIR/$OUT_NAME" | cut -f1), over GitHub's 100MB/file limit - splitting into 90MB chunks..." >&2
  split -b 90m -a 2 "$WORK_DIR/$OUT_NAME" "vendor/${OUT_NAME}.part-"
  echo "Wrote $(ls -1 "vendor/${OUT_NAME}.part-"* | wc -l | tr -d ' ') parts to vendor/. Reassemble with:" >&2
  echo "  cat vendor/${OUT_NAME}.part-* > ${OUT_NAME}" >&2
else
  cp "$WORK_DIR/$OUT_NAME" "vendor/$OUT_NAME"
  echo "Wrote vendor/$OUT_NAME ($(du -h "vendor/$OUT_NAME" | cut -f1)) as a single file - under the 100MB limit, no split needed." >&2
fi
echo "sha256 verified against Adoptium's own API response before writing." >&2
echo "SETUP.md step 8 discovers this by the OpenJDK${MAJOR}U-${IMAGE_TYPE}_x64_windows_hotspot_* glob - nothing else to update." >&2
