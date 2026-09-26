// Requires a live MySQL instance - the docker/ sandbox's `mysql` compose
// service (see docker-notes.md's "MySQL test instance" section), started
// separately as a shared fixture. Not mockable: exercises the real mysql2
// round-trip, including server.ts's per-request-connection/READ ONLY
// transaction design.
// Lives here (not under tests/) so Node's module resolution finds this
// package's own node_modules - run via `npm run build && npx tsx --test
// mcp-servers/mysql/mysql.test.ts` after `npm install` here (see
// tests/run-in-container.sh); tsx rather than compiled since a test file
// isn't published.
//
// server.ts is a persistent HTTP server (opencode connects as type: "remote",
// doesn't spawn it - see README's Design section), config-file-driven (see
// its Configuration section). This test spawns the built dist/server.js
// itself via child_process.spawn, each with its own fake $HOME
// (createFakeHome() below) so concurrent test servers never share config,
// then drives it over real Streamable HTTP once it logs "listening".
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

for (const key of ["MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"]) {
  if (!process.env[key]) {
    throw new Error(
      `${key} not set - this test needs a live MySQL instance (the docker/ sandbox's ` +
        "mysql service, see docker-notes.md) to build a database config file from, not a bare `node --test` on the host",
    );
  }
}

// Test credentials are throwaway sandbox fixtures (see docker/.env) with no
// reserved URI characters, so plain interpolation is fine here - a real
// deployment's password needs percent-encoding if it has any (see README.md).
function buildConnectString(overrides?: { password?: string }): string {
  const port = process.env.MYSQL_PORT ?? "3306";
  const password = overrides?.password ?? process.env.MYSQL_PASSWORD;
  return `mysql://${process.env.MYSQL_USER}:${password}@${process.env.MYSQL_HOST}:${port}/${process.env.MYSQL_DATABASE}`;
}

// Each spawned process gets its own fake $HOME with its own server.json
// (port) and config.json - real isolation without server.ts needing a
// test-only escape hatch, since os.homedir() reads $HOME at call time.
function createFakeHome(port: number, connectString: string): { home: string } {
  const home = mkdtempSync(join(tmpdir(), "mysql-mcp-test-"));
  const configDir = join(home, ".config", "kealthas-dev", "opencode-mcp-mysql");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "server.json"), JSON.stringify({ MYSQL_MCP_PORT: port }));
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ MYSQL_CONNECT_STRING: connectString }));

  return { home };
}

function startServer(port: number, connectString: string = buildConnectString()): Promise<ChildProcess> {
  const { home } = createFakeHome(port, connectString);
  const env = { ...process.env, HOME: home };
  delete env.MYSQL_CONFIG_ENV;

  return new Promise((resolve, reject) => {
    const child = spawn("node", [DIST_SERVER_PATH], { env });

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
  serverPort = 8235;
  serverProcess = await startServer(serverPort);
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${serverPort}/mcp`));
  client = new Client({ name: "mysql-mcp-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  if (serverProcess) await stopServer(serverProcess);
});

async function callMysqlQuery(sql: string): Promise<any> {
  const result = await client.callTool({ name: "mysql_query", arguments: { sql } });
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

test("lists exactly the mysql_query tool", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "mysql_query");
});

test("runs a plain SELECT", async () => {
  const result = await callMysqlQuery("SELECT 1 AS one, 'hello' AS greeting");
  assert.equal(result.success, true);
  assert.deepEqual(result.rows, [{ one: 1, greeting: "hello" }]);
});

test("the READ ONLY transaction wrapper rejects a DML statement, even from a fresh connection with full privileges", async () => {
  const table = `ro_dml_test_${Date.now()}`;
  await callMysqlQuery(`CREATE TABLE ${table} (id INT)`);
  try {
    const result = await callMysqlQuery(`INSERT INTO ${table} VALUES (1)`);
    assert.equal(result.success, false);
    assert.match(result.error, /READ ONLY transaction/);
  } finally {
    await callMysqlQuery(`DROP TABLE ${table}`);
  }
});

test("the READ ONLY transaction wrapper does NOT reject DDL - documents the gap, doesn't just assert it away", async () => {
  const table = `ro_ddl_test_${Date.now()}`;
  const result = await callMysqlQuery(`CREATE TABLE ${table} (id INT)`);
  // If this ever starts failing, MySQL's DDL-implicitly-commits behavior
  // changed and README.md's "Recommended read-only account" section (which
  // depends on this gap existing) needs revisiting, not this test loosened.
  assert.equal(result.success, true);

  // Confirm it actually persisted, on a fresh connection (per-request design,
  // same as every other call here) - not just that the tool reported success.
  const showResult = await callMysqlQuery(`SHOW TABLES LIKE '${table}'`);
  assert.equal(showResult.rowCount, 1);

  await callMysqlQuery(`DROP TABLE ${table}`);
});

test("a query against a nonexistent table returns a clean error, not a crash", async () => {
  const result = await callMysqlQuery("SELECT * FROM this_table_does_not_exist_12345");
  assert.equal(result.success, false);
  assert.match(result.error, /doesn't exist/);
});

test("a connection failure returns a clean error, not an MCP protocol crash", async () => {
  // Regression test: mysql.createConnection() must be inside executeQuery()'s
  // try block, or a connection failure surfaces as a raw McpError instead of
  // {success: false}. Runs its own server on a separate port with a bad
  // password, since the "good" server above already has real credentials.
  const badPort = serverPort + 1;
  const badServerProcess = await startServer(badPort, buildConnectString({ password: "definitely-wrong-password" }));
  const badTransport = new StreamableHTTPClientTransport(new URL(`http://localhost:${badPort}/mcp`));
  const badClient = new Client({ name: "mysql-mcp-test-bad-creds", version: "1.0.0" }, { capabilities: {} });
  try {
    await badClient.connect(badTransport);
    const result = await badClient.callTool({ name: "mysql_query", arguments: { sql: "SELECT 1" } });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    assert.equal(parsed.success, false);
    assert.ok(parsed.error, "expected a clean error message, not a crash");
  } finally {
    await badClient.close();
    await stopServer(badServerProcess);
  }
});
