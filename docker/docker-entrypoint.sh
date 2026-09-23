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

# mcp-servers/oracle/ reads its database connection from a JSON file
# pointed at by ORACLE_CONFIG_FILE, not from env vars directly (see
# mcp-servers/oracle/README.md's Configuration section) - generate one from
# docker-compose.yml's ORACLE_CONNECT_STRING/ORACLE_USER/ORACLE_PASSWORD so
# `cd mcp-servers/oracle && npm install && npm run build && npm start`
# still works with zero manual setup, matching a real deployment's
# file-based config rather than passing those three straight through.
mkdir -p /home/dev/.config/kealthas-dev/opencode-mcp-oracle
cat > /home/dev/.config/kealthas-dev/opencode-mcp-oracle/docker.json <<EOF
{
  "ORACLE_CONNECT_STRING": "$ORACLE_CONNECT_STRING",
  "ORACLE_USER": "$ORACLE_USER",
  "ORACLE_PASSWORD": "$ORACLE_PASSWORD"
}
EOF
export ORACLE_CONFIG_FILE=/home/dev/.config/kealthas-dev/opencode-mcp-oracle/docker.json

# Same pattern for mcp-servers/loki/ - LOKI_CONFIG_FILE instead of
# LOKI_BASE_URL directly, generated from docker-compose.yml's LOKI_BASE_URL.
mkdir -p /home/dev/.config/kealthas-dev/opencode-mcp-loki
cat > /home/dev/.config/kealthas-dev/opencode-mcp-loki/docker.json <<EOF
{
  "LOKI_BASE_URL": "$LOKI_BASE_URL"
}
EOF
export LOKI_CONFIG_FILE=/home/dev/.config/kealthas-dev/opencode-mcp-loki/docker.json

chown -R dev:dev /home/dev/.config/kealthas-dev

# Load provider API keys from the read-only ~/.keys mount into this
# container's env only - never written back to the host, never logged.
# An already-set env var (passed through docker-compose.yml) wins.
# Add another line here per provider as needed.
if [ -z "$DEEPSEEK_API_KEY" ] && [ -f /home/dev/.keys/.deepseek-key ]; then
  export DEEPSEEK_API_KEY="$(cat /home/dev/.keys/.deepseek-key)"
fi

exec runuser -u dev -- "$@"
