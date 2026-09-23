#!/usr/bin/env bash
# Meant to run *inside* the docker/ dev sandbox (see tests/README.md) -
# not against whatever node/bash happens to be on the host. Covers
# everything that needs no live opencode/model server: the plugin unit
# tests, the analyze-modules.mjs integration test (real opencode server,
# fake model provider), the oracle MCP server test (needs a real Oracle
# instance), and the loki MCP server test (needs a real Loki instance) -
# both reachable here because the shared `oracle`/`loki` services are
# started separately first, see docker/docker-notes.md. Also the memory MCP server test - needs only
# network access to install the real upstream npm package, no backing
# service.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "== unit tests (node --test) =="
# plugins/llm-review-gate/ is the one plugin in this repo with a real
# runtime dependency (zod, for its review_verdict tool's argument schema -
# every other plugin here is zero-runtime-dependency by design, see its
# package.json) - install it before its unit test tries to import the
# plugin module, same reasoning as toolkits/module-analysis below.
(cd plugins/llm-review-gate && npm install --no-audit --no-fund)

# Explicit glob, not a bare directory: Node 20 auto-detected "tests/unit"
# as a directory to scan for test files, but Node 22 (this sandbox's
# base image as of 2026-09-13, see docker/docker-notes.md) does not -
# it tries to resolve/require the path as a single module and fails
# with ERR_MODULE_NOT_FOUND. Verified directly on real node-v20.18.1 and
# node-v22.23.2 builds, not assumed. The glob form works on both.
node --test tests/unit/*.test.mjs

echo
echo "== analyze-modules.mjs integration test =="
# toolkits/module-analysis/ is its own npm package (see its package.json) -
# install @opencode-ai/sdk before driving it, same as mcp-servers/oracle below.
(cd toolkits/module-analysis && npm install --no-audit --no-fund)
node tests/integration/analyze-modules.test.mjs

echo
echo "== oracle MCP server integration test (real Oracle instance) =="
# mcp-servers/oracle/ is its own npm package - its test lives alongside it (not
# under tests/) so Node's module resolution finds its node_modules. It's
# written in TypeScript (see its README's Design section), so the test needs
# a build (dist/server.js) before it can spawn the compiled server.
(cd mcp-servers/oracle && npm install --no-audit --no-fund && npm run build && npm test)

echo
echo "== loki MCP server integration test (real Loki instance) =="
(cd mcp-servers/loki && npm install --no-audit --no-fund && npm run build && npm test)

echo
echo "== memory MCP server integration test (official @modelcontextprotocol/server-memory package) =="
(cd tests/integration/mcp-memory && npm install --no-audit --no-fund && node --test memory.test.mjs)
