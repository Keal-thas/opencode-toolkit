// Requires a live Oracle instance reachable via the env vars checked below -
// the docker/ sandbox's `oracle` compose service (see docker/docker-notes.md's
// "Oracle test instance" section), started separately as a shared fixture.
// Not something this test can mock: it exercises
// the real oracledb round-trip, including the per-request-connection /
// autoCommit design decisions server.js makes. Lives here (not under
// tests/) so Node's module resolution finds this package's own
// node_modules - run via `node --test mcp-servers/oracle/oracle.test.mjs` after
// `npm install` in this directory (see tests/run-in-container.sh).
//
// server.js is now a persistent HTTP server (opencode connects to it as
// type: "remote", not something it spawns - see README.md's Design
// section), so this test spawns it itself with `node:child_process.spawn`
// the same way a real process supervisor would, waits for its "listening"
// line on stderr, then drives it over the real Streamable HTTP transport -
// unlike the StdioClientTransport this replaced, `spawn` inherits the
// parent's environment by default, so no explicit `env: process.env` is
// needed just to make the child see ORACLE_*.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const READY_TIMEOUT_MS = 15_000;

for (const key of ["ORACLE_CONNECT_STRING", "ORACLE_USER", "ORACLE_PASSWORD"]) {
  if (!process.env[key]) {
    throw new Error(
      `${key} not set - this test needs a live Oracle instance (the docker/ sandbox's ` +
        "oracle service, see docker-notes.md), not a bare `node --test` on the host",
    );
  }
}

function startServer(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(here, "server.js")], { env: { ...process.env, ...extraEnv } });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("server.js did not report listening within the timeout"));
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
      reject(new Error(`server.js exited early (code ${code}) before listening - stderr:\n${stderr}`));
    });
  });
}

async function stopServer(child) {
  child.removeAllListeners("exit");
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
}

let serverProcess;
let serverPort;
let client;

before(async () => {
  serverPort = 8135;
  serverProcess = await startServer({ ORACLE_MCP_PORT: String(serverPort) });
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${serverPort}/mcp`));
  client = new Client({ name: "oracle-mcp-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  if (serverProcess) await stopServer(serverProcess);
});

async function callOracleQuery(sql) {
  const result = await client.callTool({ name: "oracle_query", arguments: { sql } });
  return JSON.parse(result.content[0].text);
}

test("lists exactly the oracle_query tool", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "oracle_query");
});

test("runs a plain SELECT against dual", async () => {
  const result = await callOracleQuery("SELECT 1 AS one, 'hello' AS greeting FROM dual");
  assert.equal(result.success, true);
  assert.deepEqual(result.rows, [{ ONE: 1, GREETING: "hello" }]);
});

test("a write survives the per-request connection closing (autoCommit)", async () => {
  const table = `smoke_test_${Date.now()}`;
  try {
    await callOracleQuery(`CREATE TABLE ${table} (id NUMBER, name VARCHAR2(50))`);
    const insertResult = await callOracleQuery(`INSERT INTO ${table} (id, name) VALUES (1, 'alice')`);
    assert.equal(insertResult.success, true);
    assert.equal(insertResult.rowsAffected, 1);

    // A fresh tool call gets its own fresh Oracle connection (see
    // server.js's design notes) - if the INSERT above hadn't actually
    // committed before that connection closed, this SELECT (on a
    // different connection) would come back empty.
    const selectResult = await callOracleQuery(`SELECT * FROM ${table}`);
    assert.equal(selectResult.success, true);
    assert.deepEqual(selectResult.rows, [{ ID: 1, NAME: "alice" }]);
  } finally {
    await callOracleQuery(`DROP TABLE ${table}`);
  }
});

test("a query against a nonexistent table returns a clean error, not a crash", async () => {
  const result = await callOracleQuery("SELECT * FROM this_table_does_not_exist_12345");
  assert.equal(result.success, false);
  assert.match(result.error, /ORA-00942/);
});

test("a connection failure returns a clean error, not an MCP protocol crash", async () => {
  // Regression test for the bug found while first verifying this server
  // (see git history / mcp-servers/oracle/README.md): oracledb.getConnection()
  // must be inside executeQuery()'s try block, or a connection failure
  // surfaces as a raw McpError instead of a normal {success: false} tool
  // result. Runs its own server on a separate port with a bad password,
  // since the "good" server above already has a live connection pool of
  // its own credentials baked into its process env.
  const badPort = serverPort + 1;
  const badServerProcess = await startServer({
    ORACLE_MCP_PORT: String(badPort),
    ORACLE_PASSWORD: "definitely-wrong-password",
  });
  const badTransport = new StreamableHTTPClientTransport(new URL(`http://localhost:${badPort}/mcp`));
  const badClient = new Client({ name: "oracle-mcp-test-bad-creds", version: "1.0.0" }, { capabilities: {} });
  try {
    await badClient.connect(badTransport);
    const result = await badClient.callTool({ name: "oracle_query", arguments: { sql: "SELECT 1 FROM dual" } });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.success, false);
    assert.ok(parsed.error, "expected a clean error message, not a crash");
  } finally {
    await badClient.close();
    await stopServer(badServerProcess);
  }
});
