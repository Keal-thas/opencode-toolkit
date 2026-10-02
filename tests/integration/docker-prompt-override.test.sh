#!/usr/bin/env bash
# Automates the manual verification procedure documented in
# docker/notes.md ("Verifying the system-prompt override actually
# works") - until now that check was hand-run and undocumented as a test.
#
# NOTE on where this runs: unlike the rest of tests/, this script itself
# must run on the host, because it's the thing invoking `docker run` -
# nothing can launch a container from inside one without docker-in-docker,
# which this repo's sandbox deliberately doesn't set up (see notes.md).
# It still honors the "never run opencode/node against the host" rule: the
# only thing docker itself does is start a throwaway container from the
# already-built dev image; every actual opencode invocation happens inside
# that container. There's no persistent config/data volume to touch either
# way anymore (see docker/notes.md) - the container's own writable
# layer, including whatever opencode.jsonc entrypoint.sh generates,
# is wiped with it on exit.
#
# Requires the dev image to already be built:
#   docker/dev.sh build
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="opencode-toolkit-dev:latest"

# The container's real ENTRYPOINT (entrypoint.sh) generates
# opencode.jsonc from scratch on every start now (see notes.md) -
# we ride that as-is rather than overriding --entrypoint or hand-writing
# a config here, so this exercises the exact same startup path a real
# `docker/dev.sh run` session does. The repo is bind-mounted read-only:
# this test never needs to write into it.
if ! OUTPUT="$(docker run --rm \
  -v "$REPO_ROOT:/home/dev/project:ro" \
  "$IMAGE" \
  opencode debug config)"; then
  echo "FAIL: could not run $IMAGE. Build it first:"
  echo "  docker/dev.sh build"
  exit 1
fi

fail=0
CUSTOM_PROMPT="$(cat "$REPO_ROOT/deploy/system-prompt.txt")"

check() {
  local agent="$1"
  local resolved
  resolved="$(printf '%s' "$OUTPUT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data['agent']['$agent']['prompt'])
")"
  if [[ "$resolved" != "$CUSTOM_PROMPT" ]]; then
    echo "FAIL: agent.$agent.prompt does not match deploy/system-prompt.txt verbatim"
    fail=1
  fi
  if [[ "$resolved" == *"interactive CLI tool that helps users with software engineering tasks"* ]]; then
    echo "FAIL: agent.$agent.prompt still looks like the untouched upstream default"
    fail=1
  fi
}

check build
check plan
check general

if [[ "$fail" -eq 0 ]]; then
  echo "PASS: docker sandbox resolves build/plan/general prompts to deploy/system-prompt.txt"
  exit 0
else
  echo "--- opencode debug config output ---"
  printf '%s\n' "$OUTPUT"
  exit 1
fi
