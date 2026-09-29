#!/usr/bin/env bash
# Exercises docker-entrypoint.sh's MCP config-file generation (oracle/loki/
# mysql config.json) and its DEEPSEEK_API_KEY-from-file fallback - until now
# only covered by a bare `bash -n` syntax check (unit/shell-syntax.test.mjs),
# so a wrong env-var name or connect-string shape in one of its heredocs
# would have gone undetected until a live mcp-servers/* run against the real
# fixtures.
#
# Same "must run on the host" reasoning as docker-prompt-override.test.sh:
# this is what invokes `docker run` in the first place. Deliberately raw
# `docker run` with explicit -e/-v flags, not `docker/dev.sh` - dev.sh goes
# through docker-compose.yml, which always sets every one of these vars from
# docker/.env's real fixture credentials; this test needs precise control
# over exactly which vars are set, including deliberately leaving some
# unset, so it bypasses compose entirely, same as docker-prompt-override.test.sh.
#
# Requires the dev image to already be built:
#   docker/dev.sh build
set -euo pipefail

IMAGE="opencode-toolkit-dev:latest"
fail=0

check_json() {
  local label="$1" json="$2" expected_py="$3"
  if ! printf '%s' "$json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
expected = $expected_py
assert data == expected, f'got {data!r}, expected {expected!r}'
"; then
    echo "FAIL: $label"
    echo "$json"
    fail=1
  else
    echo "PASS: $label"
  fi
}

# --- MCP config.json generation from env vars ---

ORACLE_JSON="$(docker run --rm \
  -e ORACLE_CONNECT_STRING="oracle-test-host:1521/TESTPDB" \
  -e ORACLE_USER="oracle_test_user" \
  -e ORACLE_PASSWORD="oracle_test_pw" \
  "$IMAGE" cat /home/dev/.config/kealthas-dev/opencode-mcp-oracle/config.json)"
check_json "oracle config.json matches ORACLE_CONNECT_STRING/USER/PASSWORD" "$ORACLE_JSON" "{
    'ORACLE_CONNECT_STRING': 'oracle-test-host:1521/TESTPDB',
    'ORACLE_USER': 'oracle_test_user',
    'ORACLE_PASSWORD': 'oracle_test_pw',
}"

LOKI_JSON="$(docker run --rm \
  -e LOKI_BASE_URL="http://loki-test-host:3100" \
  "$IMAGE" cat /home/dev/.config/kealthas-dev/opencode-mcp-loki/config.json)"
check_json "loki config.json matches LOKI_BASE_URL" "$LOKI_JSON" "{'LOKI_BASE_URL': 'http://loki-test-host:3100'}"

MYSQL_JSON="$(docker run --rm \
  -e MYSQL_HOST="mysql-test-host" \
  -e MYSQL_USER="mysql_test_user" \
  -e MYSQL_PASSWORD="mysql_test_pw" \
  -e MYSQL_DATABASE="mysql_test_db" \
  "$IMAGE" cat /home/dev/.config/kealthas-dev/opencode-mcp-mysql/config.json)"
check_json "mysql config.json assembles the right MYSQL_CONNECT_STRING" "$MYSQL_JSON" \
  "{'MYSQL_CONNECT_STRING': 'mysql://mysql_test_user:mysql_test_pw@mysql-test-host:3306/mysql_test_db'}"

# --- DEEPSEEK_API_KEY fallback ---

KEYFILE="$(mktemp)"
trap 'rm -f "$KEYFILE"' EXIT
printf 'test-deepseek-key-from-file' > "$KEYFILE"

FROM_FILE="$(docker run --rm -v "$KEYFILE:/home/dev/.keys/.deepseek-key:ro" "$IMAGE" printenv DEEPSEEK_API_KEY || true)"
if [[ "$FROM_FILE" == "test-deepseek-key-from-file" ]]; then
  echo "PASS: DEEPSEEK_API_KEY falls back to ~/.keys/.deepseek-key when unset"
else
  echo "FAIL: DEEPSEEK_API_KEY fallback - got '$FROM_FILE', expected the key file's content"
  fail=1
fi

EXPLICIT="$(docker run --rm -e DEEPSEEK_API_KEY="explicit-value" -v "$KEYFILE:/home/dev/.keys/.deepseek-key:ro" "$IMAGE" printenv DEEPSEEK_API_KEY || true)"
if [[ "$EXPLICIT" == "explicit-value" ]]; then
  echo "PASS: an already-set DEEPSEEK_API_KEY is not overridden by the key file"
else
  echo "FAIL: DEEPSEEK_API_KEY precedence - got '$EXPLICIT', expected the explicitly-set value to win"
  fail=1
fi

if [[ "$fail" -eq 0 ]]; then
  echo "PASS: docker-entrypoint.sh generates correct MCP configs and DEEPSEEK_API_KEY fallback"
  exit 0
else
  exit 1
fi
