#!/usr/bin/env bash
# Wrapper for docker compose that gives each worktree its own isolated Compose project, so concurrent worktrees never collide on container/network names. Always launch the sandbox through this script, not docker compose directly.
#
# Usage: same args as `docker compose -f docker/docker-compose.yml`, e.g.:
#   docker/dev.sh run --rm opencode-dev
#   docker/dev.sh run --rm opencode-dev bash tests/run-in-container.sh
set -euo pipefail

# cd to the repo root
cd "$(dirname "${BASH_SOURCE[0]}")/.."

WORKTREE_HASH="$(pwd | sha256sum | cut -c1-8)"
export COMPOSE_PROJECT_NAME="opencode-toolkit-${WORKTREE_HASH}"

exec docker compose -f docker/docker-compose.yml "$@"
