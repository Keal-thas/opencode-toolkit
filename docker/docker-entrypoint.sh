#!/bin/bash
set -e

# Regenerate opencode's config fresh on every start - the container's
# writable layer resets on every `--rm`, so nothing else would populate
# this file. Mirrors SETUP.md steps 1/2/4: build/plan/general point at
# the bind-mounted deploy/system-prompt.txt, so host edits show up
# without a rebuild. The diagnostic plugin loads from the published npm
# package by bare name - opencode installs it fresh each container
# start (see docker-notes.md's "Plugin loading" section).
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
