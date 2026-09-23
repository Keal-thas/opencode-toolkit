// Requires a live Oracle instance reachable via the env vars checked below -
// the docker/ sandbox's `oracle` compose service (see docker/docker-notes.md's
// "Oracle test instance" section), started separately as a shared fixture.
// Not something this test can mock: it exercises
// the real oracledb round-trip, including the per-request-connection /
// autoCommit design decisions server.ts makes. Lives here (not under
// tests/) so Node's module resolution finds this package's own
// node_modules - run via `npm run build && npx tsx --test mcp-servers/oracle/oracle.test.ts`
// after `npm install` in this directory (see tests/run-in-container.sh). Run
// via tsx rather than compiled like server.ts itself - a test file isn't
// published, so there's no reason to route it through `dist/`.
//
// server.ts is a persistent HTTP server (opencode connects to it as
// type: "remote", not something it spawns - see README.md's Design
// section) that reads its database connection details from a JSON file
// pointed at by ORACLE_CONFIG_FILE and its port from a fixed-path
// server.json under $HOME/.config/kealthas-dev/opencode-mcp-oracle/ (see
// README.md's Configuration section). This test spawns the built
// dist/server.js itself with `node:child_process.spawn` the same way a real
// process supervisor would, giving each spawned process its own fake $HOME
// (createFakeHome() below) so concurrent test servers never share one
// machine-wide config directory, then drives it over the real Streamable
// HTTP transport once it reports its "listening" line on stderr.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const DIST_SERVER_PATH = join(here, "dist", "server.js");
const READY_TIMEOUT_MS = 15_000;

for (const key of ["ORACLE_CONNECT_STRING", "ORACLE_USER", "ORACLE_PASSWORD"]) {
  if (!process.env[key]) {
    throw new Error(
      `${key} not set - this test needs a live Oracle instance (the docker/ sandbox's ` +
        "oracle service, see docker-notes.md) to build a database config file from, not a bare `node --test` on the host",
    );
  }
}

// Each spawned server process gets its own fake $HOME containing its own
// server.json (port) and its own database config file (an arbitrary path
// under that fake $HOME, pointed at via ORACLE_CONFIG_FILE) - real isolation
// between concurrent test servers without server.ts needing any test-only
// escape hatch. Node's os.homedir() reads $HOME at call time, so this is
// enough to give each spawned process its own config, the same as a real
// multi-instance deployment would have separate machines/accounts.
function createFakeHome(port: number, dbConfigOverrides?: Record<string, string>): { home: string; dbConfigPath: string } {
  const home = mkdtempSync(join(tmpdir(), "oracle-mcp-test-"));
  const configDir = join(home, ".config", "kealthas-dev", "opencode-mcp-oracle");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "server.json"), JSON.stringify({ ORACLE_MCP_PORT: port }));

  const dbConfigPath = join(home, "db-config.json");
  writeFileSync(
    dbConfigPath,
    JSON.stringify({
      ORACLE_CONNECT_STRING: process.env.ORACLE_CONNECT_STRING,
      ORACLE_USER: process.env.ORACLE_USER,
      ORACLE_PASSWORD: process.env.ORACLE_PASSWORD,
      ...dbConfigOverrides,
    }),
  );

  return { home, dbConfigPath };
}

function startServer(port: number, dbConfigOverrides: Record<string, string> = {}): Promise<ChildProcess> {
  const { home, dbConfigPath } = createFakeHome(port, dbConfigOverrides);

  return new Promise((resolve, reject) => {
    const child = spawn("node", [DIST_SERVER_PATH], {
      env: { ...process.env, HOME: home, ORACLE_CONFIG_FILE: dbConfigPath },
    });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("server did not report listening within the timeout"));
    }, READY_TIMEOUT_MS);

    let stderr = "";
    child.stderr!.on("data", (chunk) => {
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

async function stopServer(child: ChildProcess): Promise<void> {
  child.removeAllListeners("exit");
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
}

let serverProcess: ChildProcess;
let serverPort: number;
let client: Client;

before(async () => {
  serverPort = 8135;
  serverProcess = await startServer(serverPort);
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${serverPort}/mcp`));
  client = new Client({ name: "oracle-mcp-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  if (serverProcess) await stopServer(serverProcess);
});

async function callOracleQuery(sql: string): Promise<any> {
  const result = await client.callTool({ name: "oracle_query", arguments: { sql } });
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
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
    // server.ts's design notes) - if the INSERT above hadn't actually
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
  // result. Runs its own server on a separate port with a bad password in
  // its own fake $HOME's config file, since the "good" server above already
  // has its own real credentials baked into its own fake $HOME's config.
  const badPort = serverPort + 1;
  const badServerProcess = await startServer(badPort, { ORACLE_PASSWORD: "definitely-wrong-password" });
  const badTransport = new StreamableHTTPClientTransport(new URL(`http://localhost:${badPort}/mcp`));
  const badClient = new Client({ name: "oracle-mcp-test-bad-creds", version: "1.0.0" }, { capabilities: {} });
  try {
    await badClient.connect(badTransport);
    const result = await badClient.callTool({ name: "oracle_query", arguments: { sql: "SELECT 1 FROM dual" } });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    assert.equal(parsed.success, false);
    assert.ok(parsed.error, "expected a clean error message, not a crash");
  } finally {
    await badClient.close();
    await stopServer(badServerProcess);
  }
});
