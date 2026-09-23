#!/usr/bin/env bash
# Rebuilds vendor/spring-boot-language-server-*.tar.gz from scratch, from
# the public VS Code Marketplace. Run this on a machine with real internet
# access (not the offline target machine - see the root CLAUDE.md/SETUP.md)
# whenever the vendored version needs to be refreshed.
#
# spring-boot-language-server isn't published to Maven Central or any other
# package registry (confirmed via its own project's FAQ:
# https://github.com/spring-projects/spring-tools/wiki/FAQ) - the only
# distribution channel is VMware's "Spring Boot Tools" VS Code extension
# (publisher "vmware", extension "vscode-spring-boot"), whose .vsix bundles
# it. A .vsix is a zip; this pulls it via the Marketplace's gallery API
# (the same endpoint the VS Code client itself uses), unzips it, and
# re-packs just the language-server/ subdirectory (the exec jar + the ~170
# jar lib/ directory its manifest's Class-Path references - see this
# script's own comments below for why both are needed) as one tarball.
#
# Usage: ./fetch-spring-boot-language-server.sh [version]
# With no argument, resolves and uses the latest published version.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PUBLISHER="vmware"
EXTENSION="vscode-spring-boot"
VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Resolving latest ${PUBLISHER}.${EXTENSION} version..." >&2
  VERSION=$(curl -sS --max-time 30 -X POST \
    "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json;api-version=3.0-preview.1" \
    -d "{\"filters\":[{\"criteria\":[{\"filterType\":7,\"value\":\"${PUBLISHER}.${EXTENSION}\"}]}],\"flags\":914}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['results'][0]['extensions'][0]['versions'][0]['version'])")
fi
echo "Using version: $VERSION" >&2

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

VSIX_URL="https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${PUBLISHER}/vsextensions/${EXTENSION}/${VERSION}/vspackage"
echo "Downloading $VSIX_URL ..." >&2
# The gallery endpoint serves the .vsix gzip-encoded on top of it already
# being a zip - a short --max-time here silently truncates the download
# (curl exits 0 anyway), which then fails opaquely at `gunzip`/`unzip`, not
# at curl. Learned by hitting exactly this once during development - a
# generous --max-time and checking the actual downloaded size against what
# curl reports matters more than it looks like it should.
curl -sSL --max-time 300 --retry 3 -w "http_code=%{http_code} size=%{size_download}\n" \
  -o "$WORK_DIR/extension.vsix.gz" "$VSIX_URL"
gunzip "$WORK_DIR/extension.vsix.gz"
unzip -q "$WORK_DIR/extension.vsix" -d "$WORK_DIR/extracted"

LS_DIR="$WORK_DIR/extracted/extension/language-server"
EXEC_JAR=$(find "$LS_DIR" -maxdepth 1 -name "spring-boot-language-server-*-exec.jar" | head -1)
if [ -z "$EXEC_JAR" ] || [ ! -d "$LS_DIR/lib" ]; then
  echo "Expected language-server/*-exec.jar + language-server/lib/ not found - the extension's internal layout may have changed. Inspect $WORK_DIR manually." >&2
  exit 1
fi
JAR_BASENAME=$(basename "$EXEC_JAR")
# e.g. spring-boot-language-server-2.5.0-SNAPSHOT-exec.jar -> 2.5.0-SNAPSHOT
LS_VERSION=$(echo "$JAR_BASENAME" | sed -E 's/^spring-boot-language-server-(.+)-exec\.jar$/\1/')

echo "Found $JAR_BASENAME (version $LS_VERSION), lib/ has $(find "$LS_DIR/lib" -name '*.jar' | wc -l | tr -d ' ') jars" >&2

# Both the exec jar AND lib/ are required, not just the jar - its
# MANIFEST.MF Class-Path lists ~170 "lib/*.jar" entries resolved relative
# to the jar's own location at runtime. This is a full embedded Spring
# Boot application (Tomcat, the real Eclipse JDT core, OpenRewrite,
# jgit, ...), not a single-file fat jar - the whole lib/ directory
# (~80MB, mostly already-compressed jars, so tar -z barely shrinks it
# further) has to ship alongside it.
mkdir -p vendor
OUT="vendor/spring-boot-language-server-${LS_VERSION}.tar.gz"
tar -czf "$OUT" -C "$LS_DIR" "$JAR_BASENAME" lib
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))" >&2
echo "server.ts discovers the exec jar name and version from this tarball automatically (see resolveLanguageServerDir() in src/server.ts) - nothing else to update." >&2
