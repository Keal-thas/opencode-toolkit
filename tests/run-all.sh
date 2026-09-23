#!/usr/bin/env bash
# Single entry point for this repo's whole test suite. Run from the repo
# root (or anywhere - it cd's to the repo root itself) on the host, with
# Docker running. See tests/README.md for what runs where and why.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "## Building the dev sandbox image (skipped if already up to date) =="
docker/dev.sh build

echo
echo "## In-container tests: unit tests + analyze-modules.ts (real opencode server, fake model) =="
docker/dev.sh run --rm opencode-dev bash tests/run-in-container.sh

echo
echo "## Docker sandbox integration test: system-prompt override via a real opencode install =="
bash tests/integration/docker-prompt-override.test.sh

echo
echo "All tests passed."
