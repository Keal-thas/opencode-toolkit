#!/usr/bin/env bash
# Publishes each vendor/*.zip.part-* file as its own tiny, non-"latest"
# version of the already-bootstrapped root @kealthas-dev/opencode-toolkit
# package - NOT as separate new package names. A brand-new package name
# needs a one-time manual `npm login` + `npm publish` bootstrap before npm
# Trusted Publishing can touch it (see mcp-servers/TODO.md's java-lsp/
# spring-lsp publish item for why) - CI has no such credential. Reusing the
# root package's own name sidesteps that entirely, since release.yml's
# existing OIDC Trusted Publishing already has publish rights on it.
#
# Why this is needed at all: the whole vendor/ JDK together (~195MB) trips
# registry.npmjs.org's real, undocumented per-publish payload ceiling
# (empirically somewhere between 172MB and 202MB packed - see
# docs/lessons-learned.md) even after trimming everything else out of the
# root package. Each individual part, published on its own, is far under
# that ceiling.
#
# Published under dist-tag jdk-part<N> (via --tag, never touching
# `latest`), so ordinary `npm view`/`npm install`/`npm pack` of this
# package is completely unaffected - these versions are only ever reached
# by explicitly requesting that exact version or dist-tag. SETUP.md step 8
# does exactly that, three times, then reassembles.
#
# Idempotent like release.yml's own per-package loop: skips a part whose
# version is already published, so re-running this (a later tag push,
# after the JDK's already been vendored once) is a no-op.
#
# Run from the repo root, needs npm publish rights on
# @kealthas-dev/opencode-toolkit (release.yml's own OIDC Trusted
# Publishing already has this - see docs/npm-publishing.md).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PKG_NAME="@kealthas-dev/opencode-toolkit"
# Reserved for JDK-part publishes only (0.0.<offset+1>, 0.0.<offset+2>, ...)
# - always below the real 1.x.y release line release.yml bumps on every
# tag, so these never become `latest` even by accident.
PART_BASE_VERSION="0.0"
# 0.0.1 (the first-ever attempt, 2026-09-24) got stuck on npm's backend in
# a "staged but never finalized" state - neither visible via npm view/pack
# nor re-publishable (a real `npm publish` retry hit a genuine
# `409 Conflict - Cannot publish over previously staged version "0.0.1"`,
# ~20 minutes after the original publish reported success). npm gives no
# way to clear or reclaim a version number once this happens, so 0.0.1 is
# permanently burned - bump this offset (never reuse a burned number) if a
# future part ever lands in the same stuck state.
PART_VERSION_OFFSET=10

i=0
for part in vendor/*.zip.part-*; do
  if [ ! -e "$part" ]; then
    echo "No vendor/*.zip.part-* files found - nothing to publish." >&2
    exit 0
  fi
  i=$((i + 1))
  version="${PART_BASE_VERSION}.$((i + PART_VERSION_OFFSET))"
  tag="jdk-part${i}"
  part_name=$(basename "$part")

  if npm view "${PKG_NAME}@${version}" version >/dev/null 2>&1; then
    echo "${PKG_NAME}@${version} (dist-tag ${tag}, ${part_name}) already published, skipping" >&2
    continue
  fi

  work_dir=$(mktemp -d)
  cp "$part" "$work_dir/$part_name"
  cat > "$work_dir/package.json" <<EOF
{
  "name": "${PKG_NAME}",
  "version": "${version}",
  "description": "Not a usable package on its own - one raw chunk of vendor/${part_name%.part-*}, the split JDK archive from the main @kealthas-dev/opencode-toolkit repo. Never installed directly; reassembled by SETUP.md step 8. See docs/lessons-learned.md and mcp-servers/TODO.md for why this exists.",
  "license": "UNLICENSED",
  "repository": {
    "type": "git",
    "url": "https://github.com/Keal-thas/opencode-toolkit.git"
  },
  "files": ["${part_name}"],
  "publishConfig": { "access": "public" }
}
EOF
  echo "Publishing ${PKG_NAME}@${version} (dist-tag ${tag}, ${part_name}, $(du -h "$part" | cut -f1))" >&2
  (cd "$work_dir" && npm publish --access public --tag "$tag")
  rm -rf "$work_dir"

  # Wait for the registry to actually confirm this version before starting
  # the next publish, rather than firing all three back-to-back - the
  # 0.0.1 incident (see docs/lessons-learned.md) was three publishes to
  # the same package name within ~15 seconds of each other, and the first
  # one got stuck server-side in a way a bare "npm publish exited 0"
  # never caught. This also surfaces a stuck part immediately, as a clear
  # failed step, instead of discovering it minutes later.
  echo "Waiting for ${PKG_NAME}@${version} to become visible before continuing..." >&2
  for attempt in $(seq 1 20); do
    if npm view "${PKG_NAME}@${version}" version >/dev/null 2>&1; then
      echo "  confirmed visible" >&2
      break
    fi
    if [ "$attempt" -eq 20 ]; then
      echo "${PKG_NAME}@${version} still not visible after 5 minutes - treating as stuck, aborting." >&2
      exit 1
    fi
    sleep 15
  done
done
