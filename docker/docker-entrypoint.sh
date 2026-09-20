#!/bin/bash
set -e

# Regenerate opencode's config fresh on every start. There's no
# persistent opencode-config volume anymore (see docker-compose.yml and
# docs/lessons-learned.md), so nothing else would ever populate this
# file - matches the container's own writable layer resetting on every
# `--rm`. Mirrors SETUP.md steps 1/2/4 for the real deployment:
# build/plan/general point at system-prompt.txt through the live
# bind-mounted project dir (not a build-time copy), so host edits to
# that file show up without a rebuild. The diagnostic dump plugin loads
# from the real published npm package by bare name instead - editing
# plugins/system-prompt-tools/system-prompt-tools.ts and publishing a
# new version needs the image rebuilt (`docker/dev.sh build`) to pick
# it up here, since the actual install was pre-warmed into the image
# layer at build time (see the Dockerfile) - see docker-notes.md.
cat > /home/dev/.config/opencode/opencode.jsonc <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "build": { "prompt": "{file:/home/dev/project/deploy/system-prompt.txt}" },
    "plan": { "prompt": "{file:/home/dev/project/deploy/system-prompt.txt}" },
    "general": { "prompt": "{file:/home/dev/project/deploy/system-prompt.txt}" }
  },
  "plugin": ["@kealthas-dev/opencode-system-prompt-tools"]
}
EOF
chown dev:dev /home/dev/.config/opencode/opencode.jsonc

# Load provider API keys from the read-only ~/.keys mount into this
# container's env only - never written back to the host, never logged.
# An already-set env var (passed through docker-compose.yml) wins.
# Add another line here per provider as needed.
if [ -z "$DEEPSEEK_API_KEY" ] && [ -f /home/dev/.keys/.deepseek-key ]; then
  export DEEPSEEK_API_KEY="$(cat /home/dev/.keys/.deepseek-key)"
fi

exec runuser -u dev -- "$@"
