// Requires a live Oracle instance - the docker/ sandbox's `oracle` compose
// service (see notes.md's "Oracle test instance" section), started
// separately as a shared fixture. Not mockable: exercises the real oracledb
// round-trip.
// Lives here (not under tests/) so Node's module resolution finds this
// package's own node_modules - run via `npm run build && npm test` after
// `npm install` here (see tests/run-in-container.sh); tsx rather than
// compiled since a test file isn't published.
//
// The package is a persistent HTTP server (dist/server.js, POST /query) plus a
// command-line client (dist/cli.js, `opencode-oracle-query`). This test spawns the built
// server with its own fake $HOME (createFakeHome() below) so concurrent test
// servers never share config, waits for it to log "listening", then drives it
// through the opencode-oracle-query command the way an agent would.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import oracledb from "oracledb";

const here = dirname(fileURLToPath(import.meta.url));
const DIST_SERVER_PATH = join(here, "dist", "server.js");
const DIST_CLI_PATH = join(here, "dist", "cli.js");
const READY_TIMEOUT_MS = 15_000;

for (const key of ["ORACLE_CONNECT_STRING", "ORACLE_USER", "ORACLE_PASSWORD"]) {
  if (!process.env[key]) {
    throw new Error(
      `${key} not set - this test needs a live Oracle instance (the docker/ sandbox's ` +
        "oracle service, see notes.md) to build a database config file from, not a bare `node --test` on the host",
    );
  }
}

interface Instance {
  home: string;
  port: number;
  configPath: string;
  child: ChildProcess;
}

// Each spawned process gets its own fake $HOME with its own server.json
// (port) and config.json - real isolation without server.ts needing a
// test-only escape hatch, since os.homedir() reads $HOME at call time.
// Written to the default config.json location - ORACLE_CONFIG_ENV only
// takes a bare name, never a path, so there's nothing else to point at.
function createFakeHome(port: number, dbConfigOverrides?: Record<string, string | number>): { home: string; configPath: string } {
  const home = mkdtempSync(join(tmpdir(), "oracle-test-"));
  const configDir = join(home, ".config", "kealthas-dev", "opencode-mcp-oracle");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "server.json"), JSON.stringify({ ORACLE_MCP_PORT: port }));
  const configPath = join(configDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      ORACLE_CONNECT_STRING: process.env.ORACLE_CONNECT_STRING,
      ORACLE_USER: process.env.ORACLE_USER,
      ORACLE_PASSWORD: process.env.ORACLE_PASSWORD,
      ...dbConfigOverrides,
    }),
  );
  return { home, configPath };
}

// os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
const envFor = (home: string) => {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.ORACLE_CONFIG_ENV;
  delete env.ORACLE_MCP_PORT;
  return env;
};

function startServer(port: number, dbConfigOverrides: Record<string, string | number> = {}): Promise<Instance> {
  const { home, configPath } = createFakeHome(port, dbConfigOverrides);
  return new Promise((resolve, reject) => {
    const child = spawn("node", [DIST_SERVER_PATH], { env: envFor(home) });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("server did not report listening within the timeout"));
    }, READY_TIMEOUT_MS);

    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("listening on")) {
        clearTimeout(timeout);
        resolve({ home, port, configPath, child });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited early (code ${code}) before listening - stderr:\n${stderr}`));
    });
  });
}

async function stopServer(instance: Instance): Promise<void> {
  instance.child.removeAllListeners("exit");
  instance.child.kill();
  await new Promise((resolve) => instance.child.once("exit", resolve));
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs `opencode-oracle-query <args>` against an instance's fake $HOME, so it finds that server's port.
function cli(instance: Pick<Instance, "home">, ...args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile("node", [DIST_CLI_PATH, ...args], { env: envFor(instance.home) }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number) : 0, stdout, stderr });
    });
  });
}

// DDL and writes for fixtures go straight through the driver: the CLI is read-only by design.
async function direct<T>(fn: (c: oracledb.Connection) => Promise<T>): Promise<T> {
  const c = await oracledb.getConnection({
    connectString: process.env.ORACLE_CONNECT_STRING!,
    user: process.env.ORACLE_USER!,
    password: process.env.ORACLE_PASSWORD!,
  });
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}

let main: Instance;
const BASE_PORT = 8135;

before(async () => {
  main = await startServer(BASE_PORT);
});

after(async () => {
  if (main) await stopServer(main);
});

test("prints a plain SELECT as CSV", async () => {
  const r = await cli(main, "SELECT 1 AS one, 'hello' AS greeting FROM dual");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "ONE,GREETING\n1,hello\n");
});

test("a trailing semicolon is accepted for a SELECT", async () => {
  const r = await cli(main, "SELECT 1 AS one FROM dual;");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "ONE\n1\n");
});

test("--json prints one JSON object per row", async () => {
  const r = await cli(main, "SELECT level AS n FROM dual CONNECT BY level <= 2", "--json");
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n").map((l) => JSON.parse(l)), [{ N: 1 }, { N: 2 }]);
});

test("--format tsv separates by tabs", async () => {
  const r = await cli(main, "SELECT 1 AS a, 2 AS b FROM dual", "--format", "tsv");
  assert.equal(r.stdout, "A\tB\n1\t2\n");
});

test("CSV quotes commas, quotes and newlines", async () => {
  const r = await cli(main, `SELECT 'a,b' AS x, 'say "hi"' AS y, 'one'||CHR(10)||'two' AS z FROM dual`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'X,Y,Z\n"a,b","say ""hi""","one\ntwo"\n');
});

test("output stops at 100 rows by default and says so on stderr", async () => {
  const r = await cli(main, "SELECT level AS n FROM dual CONNECT BY level <= 250");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 1 + 100, "header plus 100 rows");
  assert.match(r.stderr, /first 100 rows, more exist/);
});

test("--limit, --all and --out change how many rows come back", async () => {
  const sql = "SELECT level AS n FROM dual CONNECT BY level <= 250";
  const limited = await cli(main, sql, "--limit", "5");
  assert.equal(limited.stdout.trim().split("\n").length, 1 + 5);
  assert.match(limited.stderr, /first 5 rows/);

  const all = await cli(main, sql, "--all");
  assert.equal(all.stdout.trim().split("\n").length, 1 + 250);
  assert.equal(all.stderr, "");

  const file = join(mkdtempSync(join(tmpdir(), "oracle-out-")), "rows.csv");
  const out = await cli(main, sql, "--out", file);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /wrote 250 rows to /);
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1 + 250);
});

test("the server's own cap (ORACLE_MAX_ROWS) holds even for --all", async () => {
  const capped = await startServer(BASE_PORT + 2, { ORACLE_MAX_ROWS: 7 });
  try {
    const r = await cli(capped, "SELECT level AS n FROM dual CONNECT BY level <= 50", "--all");
    assert.equal(r.stdout.trim().split("\n").length, 1 + 7);
    assert.match(r.stderr, /first 7 rows, more exist/);
  } finally {
    await stopServer(capped);
  }
});

test("a join with duplicate column names keeps both values", async () => {
  // The driver renames the second one (ID_1), so no value is lost to a key collision.
  const csv = await cli(main, "SELECT 1 AS id, 2 AS id FROM dual");
  assert.equal(csv.stdout, "ID,ID_1\n1,2\n");
  const json = await cli(main, "SELECT 1 AS id, 2 AS id FROM dual", "--json");
  assert.deepEqual(JSON.parse(json.stdout), { ID: 1, ID_1: 2 });
});

test("dates, CLOB, BLOB and RAW come back as plain text", async () => {
  const r = await cli(
    main,
    `SELECT DATE '2024-01-02' AS d, TO_TIMESTAMP('2024-01-02 03:04:05.5','YYYY-MM-DD HH24:MI:SS.FF') AS ts, TO_CLOB('clob text') AS c, TO_BLOB(UTL_RAW.CAST_TO_RAW('hi')) AS b, UTL_RAW.CAST_TO_RAW('hi') AS r FROM dual`,
    "--json",
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    D: "2024-01-02 00:00:00",
    TS: "2024-01-02 03:04:05.500",
    C: "clob text",
    B: Buffer.from("hi").toString("base64"),
    R: "6869",
  });
});

test("INSERT, UPDATE and DELETE are refused inside the read-only transaction, and change nothing", async () => {
  const table = `ro_test_${Date.now()}`;
  await direct(async (c) => {
    await c.execute(`CREATE TABLE ${table} (id NUMBER)`);
    await c.execute(`INSERT INTO ${table} VALUES (1)`, [], { autoCommit: true });
  });
  // A read-only transaction cannot read a table whose definition changed a moment ago (ORA-01466, seconds of granularity).
  await new Promise((resolve) => setTimeout(resolve, 4000));
  try {
    for (const sql of [`INSERT INTO ${table} VALUES (2)`, `UPDATE ${table} SET id = 9`, `DELETE FROM ${table}`]) {
      const r = await cli(main, sql);
      assert.equal(r.code, 1, `${sql} should fail`);
      assert.ok(r.stderr.startsWith("ORA-01456"), `${sql}: ${JSON.stringify(r.stderr)}`);
    }
    const after = await cli(main, `SELECT id FROM ${table}`);
    assert.equal(after.stdout, "ID\n1\n", `the table is unchanged (exit ${after.code}: ${after.stderr})`);
  } finally {
    await direct((c) => c.execute(`DROP TABLE ${table}`));
  }
});

test("a SQL error exits 1 with the database's own message, not wrapped", async () => {
  const r = await cli(main, "SELECT * FROM this_table_does_not_exist_12345");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.startsWith("ORA-00942"), `nothing in front of the message: ${JSON.stringify(r.stderr)}`);
});

test("usage errors exit 2", async () => {
  assert.equal((await cli(main)).code, 2);
  assert.equal((await cli(main, "SELECT 1 FROM dual", "--limit", "abc")).code, 2);
  assert.equal((await cli(main, "SELECT 1 FROM dual", "--bogus")).code, 2);
  assert.equal((await cli(main, "SELECT 1 FROM dual", "SELECT 2 FROM dual")).code, 2, "one statement only");
  const help = await cli(main, "--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: opencode-oracle-query/);
});

test("bad credentials exit 3 with a clean message, not a crash", async () => {
  const bad = await startServer(BASE_PORT + 1, { ORACLE_PASSWORD: "definitely-wrong-password" });
  try {
    const r = await cli(bad, "SELECT 1 FROM dual");
    assert.equal(r.code, 3);
    assert.ok(r.stderr.startsWith("ORA-01017"), `the database's message, untouched: ${JSON.stringify(r.stderr)}`);
  } finally {
    await stopServer(bad);
  }
});

test("no server running exits 3 and says how to fix it", async () => {
  const { home } = createFakeHome(BASE_PORT + 9); // nothing listens there
  const r = await cli({ home }, "SELECT 1 FROM dual");
  assert.equal(r.code, 3);
  assert.match(r.stderr, /cannot reach the oracle query server on port 8144/);
});

test("a broken config file fails that query only, and the server recovers when it is fixed", async () => {
  const instance = await startServer(BASE_PORT + 3);
  try {
    const good = readFileSync(instance.configPath, "utf8");
    writeFileSync(instance.configPath, "{ this is not json");
    const broken = await cli(instance, "SELECT 1 FROM dual");
    assert.equal(broken.code, 3);
    assert.match(broken.stderr, /Failed to load database config/);

    writeFileSync(instance.configPath, good);
    const fixed = await cli(instance, "SELECT 1 AS one FROM dual");
    assert.equal(fixed.code, 0, `the server survived the bad file: ${fixed.stderr}`);
  } finally {
    await stopServer(instance);
  }
});

test("a statement with no result set says so instead of printing an empty line", async () => {
  // DDL is not stopped by the read-only transaction (it commits first), so this uses a harmless statement.
  const r = await cli(main, "ALTER SESSION SET NLS_LANGUAGE = 'AMERICAN'");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "statement executed, no result set\n");
});
