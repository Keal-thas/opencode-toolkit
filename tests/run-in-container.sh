#!/usr/bin/env bash
# Meant to run *inside* the docker/ dev sandbox (see tests/README.md) -
# not against whatever node/bash happens to be on the host. Covers
# everything that needs no live opencode/model server: the plugin unit
# tests, the guard-plugins and verifier-agent integration tests (a real
# opencode with a fake model provider), the oracle, loki, mysql and redis
# command tests (each needs its real instance, all reachable here because
# the shared `oracle`/`loki`/`mysql`/`redis` services are started separately
# first, see docker/notes.md), the memory MCP server test (the official
# upstream package, not our own code; it needs only network access to
# install it) and the playwright MCP server test (the official
# @playwright/mcp package, see mcp-servers/playwright/README.md, against a
# real headless Chromium globally installed with its Linux system deps in
# docker/Dockerfile; no external service needed, it drives a fixture page
# served by the test itself).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "== unit tests (node --test) =="
# plugins/llm-review-gate/ is the one plugin in this repo with a real
# runtime dependency (zod, for its review_verdict tool's argument schema -
# every other plugin here is zero-runtime-dependency by design, see its
# package.json) - install it before its unit test tries to import the
# plugin module.
(cd plugins/llm-review-gate && npm install --no-audit --no-fund)

# Explicit glob, not a bare directory: Node 20 auto-detected "tests/unit"
# as a directory to scan for test files, but Node 22 (this sandbox's
# base image as of 2026-09-13, see docker/notes.md) does not -
# it tries to resolve/require the path as a single module and fails
# with ERR_MODULE_NOT_FOUND. Verified directly on real node-v20.18.1 and
# node-v22.23.2 builds, not assumed. The glob form works on both.
node --test tests/unit/*.test.mjs

echo
echo "== guard plugins integration test (loop-guard and path-guard in a real opencode) =="
node tests/integration/guard-plugins.test.mjs

echo
echo "== verifier agent integration test (real opencode, fake model) =="
node tests/integration/verifier-agent.test.mjs

echo
echo "== oracle command integration test (real Oracle instance) =="
# mcp-servers/oracle/ is its own npm package - its test lives alongside it (not
# under tests/) so Node's module resolution finds its node_modules. It's
# written in TypeScript (see its README's Design section), so the test needs
# a build (dist/server.js) before it can spawn the compiled server.
(cd mcp-servers/oracle && npm install --no-audit --no-fund && npm run build && npm test)

echo
echo "== loki command integration test (real Loki instance) =="
(cd mcp-servers/loki && npm install --no-audit --no-fund && npm run build && npm test)

echo
echo "== mysql command integration test (real MySQL instance) =="
(cd mcp-servers/mysql && npm install --no-audit --no-fund && npm run build && npm test)

echo
echo "== memory MCP server integration test (official @modelcontextprotocol/server-memory package) =="
(cd tests/integration/mcp-memory && npm install --no-audit --no-fund && node --test memory.test.mjs)

echo
echo "== redis command integration test (real Redis instance) =="
(cd mcp-servers/redis && npm install --no-audit --no-fund && npm run build && npm test)

echo
echo "== playwright MCP server integration test (official @playwright/mcp package, real headless Chromium) =="
(cd tests/integration/mcp-playwright && npm install --no-audit --no-fund && node --test playwright.test.mjs)
