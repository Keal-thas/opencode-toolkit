// Requires a live Loki instance reachable via LOKI_BASE_URL - the docker/
// sandbox's `loki` compose service (see docker/docker-notes.md's "Loki
// test instance" section), which `docker/dev.sh` always brings up first.
// Not something this test can mock: it exercises the real Loki HTTP query
// API round-trip. Lives here (not under tests/) so Node's module
// resolution finds this package's own node_modules - run via
// `npm run build && node --test mcp-servers/loki/loki.test.mjs` after
// `npm install` in this directory (see tests/run-in-container.sh).
//
// server.ts is a persistent HTTP server (opencode connects to it as
// type: "remote", not something it spawns - see README.md's Design
// section) that reads its Loki connection details from a JSON file pointed
// at by LOKI_CONFIG_FILE and its port from a fixed-path server.json under
// $HOME/.config/kealthas-dev/opencode-mcp-loki/ (see README.md's
// Configuration section, and mcp-servers/oracle/oracle.test.mjs for the
// same fake-$HOME pattern this test reuses). This test spawns the built
// dist/server.js itself with `node:child_process.spawn` the same way a
// real process supervisor would, giving it its own fake $HOME so it never
// shares config with a real server that might be running in the same
// container, then drives it over the real Streamable HTTP transport once
// it reports its "listening" line on stderr.
//
// This server's tools are read-only, so there's no MCP tool that can seed
// test data the way mcp-servers/oracle/oracle.test.mjs's CREATE TABLE/INSERT does
// through oracle_query - instead this test pushes its own log lines
// straight to Loki's own push API (POST /loki/api/v1/push), independent
// of the MCP server entirely, then reads them back through the tools.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const DIST_SERVER_PATH = join(here, "dist", "server.js");
const READY_TIMEOUT_MS = 15_000;

if (!process.env.LOKI_BASE_URL) {
  throw new Error(
    "LOKI_BASE_URL not set - this test needs a live Loki instance (the docker/ sandbox's " +
      "loki service, see docker-notes.md) to build a config file from, not a bare `node --test` on the host",
  );
}

function startServer(port) {
  const home = mkdtempSync(join(tmpdir(), "loki-mcp-test-"));
  const configDir = join(home, ".config", "kealthas-dev", "opencode-mcp-loki");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "server.json"), JSON.stringify({ LOKI_MCP_PORT: port }));

  const configPath = join(home, "loki-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      LOKI_BASE_URL: process.env.LOKI_BASE_URL,
      LOKI_USERNAME: process.env.LOKI_USERNAME,
      LOKI_PASSWORD: process.env.LOKI_PASSWORD,
      LOKI_ORG_ID: process.env.LOKI_ORG_ID,
    }),
  );

  return new Promise((resolve, reject) => {
    const child = spawn("node", [DIST_SERVER_PATH], {
      env: { ...process.env, HOME: home, LOKI_CONFIG_FILE: configPath },
    });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("server did not report listening within the timeout"));
    }, READY_TIMEOUT_MS);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("listening on")) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited early (code ${code}) before listening - stderr:\n${stderr}`));
    });
  });
}

async function stopServer(child) {
  child.removeAllListeners("exit");
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
}

// A fresh label value per run, not a fixed one - this Loki instance is a
// shared fixture (see docker-notes.md), so a fixed value could collide
// with a concurrent test run the same way mcp-servers/oracle/oracle.test.mjs's
// dynamic table name avoids colliding with a concurrent Oracle test.
const testAppLabel = `loki_mcp_test_${Date.now()}`;
const testLogLine = `hello from loki mcp test ${Date.now()}`;
const windowStartNs = String((Date.now() - 5 * 60_000) * 1_000_000);
const windowEndNs = String((Date.now() + 5 * 60_000) * 1_000_000);

async function pushTestLogLine() {
  const nowNs = String(Date.now() * 1_000_000);
  const response = await fetch(new URL("/loki/api/v1/push", process.env.LOKI_BASE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      streams: [
        {
          stream: { app: testAppLabel, source: "loki-mcp-test" },
          values: [[nowNs, testLogLine]],
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Seeding Loki failed: ${response.status} ${await response.text()}`);
  }
}

let serverProcess;
let serverPort;
let client;

before(async () => {
  await pushTestLogLine();

  serverPort = 8235;
  serverProcess = await startServer(serverPort);
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${serverPort}/mcp`));
  client = new Client({ name: "loki-mcp-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  if (serverProcess) await stopServer(serverProcess);
});

async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(result.content[0].text);
}

test("lists exactly the three loki tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["loki_label_values", "loki_labels", "loki_query_range"],
  );
});

test("loki_labels finds the pushed test stream's label name", async () => {
  const result = await callTool("loki_labels", {});
  assert.equal(result.success, true);
  assert.ok(result.data.includes("app"), `expected "app" in labels, got ${JSON.stringify(result.data)}`);
});

test("loki_label_values finds the pushed test label value", async () => {
  const result = await callTool("loki_label_values", { label: "app" });
  assert.equal(result.success, true);
  assert.ok(
    result.data.includes(testAppLabel),
    `expected ${testAppLabel} in label values, got ${JSON.stringify(result.data)}`,
  );
});

test("loki_query_range finds the pushed log line by content", async () => {
  const result = await callTool("loki_query_range", {
    query: `{app="${testAppLabel}"}`,
    start: windowStartNs,
    end: windowEndNs,
  });
  assert.equal(result.success, true);
  const lines = result.data.result.flatMap((stream) => stream.values.map(([, line]) => line));
  assert.ok(lines.includes(testLogLine), `expected pushed log line in result, got ${JSON.stringify(lines)}`);
});

test("a query matching nothing returns an empty result, not an error", async () => {
  const result = await callTool("loki_query_range", {
    query: `{app="definitely_does_not_exist_${Date.now()}"}`,
    start: windowStartNs,
    end: windowEndNs,
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.data.result, []);
});

test("malformed LogQL returns a clean error, not a crash", async () => {
  const result = await callTool("loki_query_range", { query: "{app=" });
  assert.equal(result.success, false);
  assert.ok(result.error, "expected a clean error message, not a crash");
});
