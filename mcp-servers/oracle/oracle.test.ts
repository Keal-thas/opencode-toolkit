// Requires a live Oracle instance - the docker/ sandbox's `oracle` compose
// service (see notes.md's "Oracle test instance" section), started
// separately as a shared fixture. Not mockable: exercises the real oracledb
// round-trip.
// Lives here (not under tests/) so Node's module resolution finds this
// package's own node_modules - run via `npm run build && npm test` after
// `npm install` here (see tests/run-in-container.sh); tsx rather than
// compiled since a test file isn't published.
//
// The package is one command, dist/cli.js, that connects straight to Oracle. Each test runs it the way an
// agent would, with its own fake $HOME holding a config file (os.homedir() reads $HOME at call time, so
// the command needs no test-only escape hatch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import oracledb from "oracledb";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "dist", "cli.js");

for (const key of ["ORACLE_CONNECT_STRING", "ORACLE_USER", "ORACLE_PASSWORD"]) {
  if (!process.env[key]) {
    throw new Error(
      `${key} not set - this test needs a live Oracle instance (the docker/ sandbox's ` +
        "oracle service, see notes.md) to build a database config file from, not a bare `node --test` on the host",
    );
  }
}

// Written to the default config.json location - ORACLE_CONFIG_ENV only takes a bare name, never a path.
function createFakeHome(overrides?: Record<string, string>): { home: string; configPath: string } {
  const home = mkdtempSync(join(tmpdir(), "oracle-test-"));
  const configDir = join(home, ".config", "kealthas-dev", "opencode-mcp-oracle");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      ORACLE_CONNECT_STRING: process.env.ORACLE_CONNECT_STRING,
      ORACLE_USER: process.env.ORACLE_USER,
      ORACLE_PASSWORD: process.env.ORACLE_PASSWORD,
      ...overrides,
    }),
  );
  return { home, configPath };
}

const good = createFakeHome();

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

// os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
function run(home: string, ...args: string[]): Promise<CliResult> {
  return runWithStdin(home, undefined, ...args);
}

// stdin is closed at once when there is nothing to send, so a run that would read it does not wait.
function runWithStdin(home: string, stdin: string | undefined, ...args: string[]): Promise<CliResult> {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.ORACLE_CONFIG_ENV;
  return new Promise((resolve) => {
    const child = execFile("node", [CLI, ...args], { env, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number) : 0, stdout, stderr });
    });
    child.stdin!.end(stdin ?? "");
  });
}
const cli = (...args: string[]) => run(good.home, ...args);

// DDL and writes for fixtures go straight through the driver: the command is read-only by design.
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

test("prints a plain SELECT as CSV", async () => {
  const r = await cli("SELECT 1 AS one, 'hello' AS greeting FROM dual");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "ONE,GREETING\n1,hello\n");
});

test("a trailing semicolon is accepted for a SELECT", async () => {
  const r = await cli("SELECT 1 AS one FROM dual;");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "ONE\n1\n");
});

test("CSV quotes commas, quotes and newlines", async () => {
  const r = await cli(`SELECT 'a,b' AS x, 'say "hi"' AS y, 'one'||CHR(10)||'two' AS z FROM dual`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'X,Y,Z\n"a,b","say ""hi""","one\ntwo"\n');
});

test("nothing is cut off: every row of a large result comes back", async () => {
  const r = await cli("SELECT level AS n FROM dual CONNECT BY level <= 50000");
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1 + 50000, "header plus every row");
  assert.equal(lines.at(-1), "50000");
  assert.equal(r.stderr, "", "no notice, nothing was left out");
});

test("a pipe closed early (| head) is not an error", async () => {
  const env = { ...process.env, HOME: good.home, USERPROFILE: good.home };
  const out = await new Promise<{ stdout: string; stderr: string }>((resolve) =>
    execFile("bash", ["-c", `node "${CLI}" "SELECT level AS n FROM dual CONNECT BY level <= 200000" | head -n 3`], { env }, (_e, stdout, stderr) => resolve({ stdout, stderr })),
  );
  assert.equal(out.stdout, "N\n1\n2\n");
  assert.equal(out.stderr, "", "no EPIPE stack trace");
});

test("a join with duplicate column names keeps both values", async () => {
  // The driver renames the second one (ID_1), so no value is lost.
  const r = await cli("SELECT 1 AS id, 2 AS id FROM dual");
  assert.equal(r.stdout, "ID,ID_1\n1,2\n");
});

test("dates, CLOB, BLOB and RAW come back as plain text", async () => {
  const r = await cli(
    `SELECT DATE '2024-01-02' AS d, TO_TIMESTAMP('2024-01-02 03:04:05.5','YYYY-MM-DD HH24:MI:SS.FF') AS ts, TO_CLOB('clob text') AS c, TO_BLOB(UTL_RAW.CAST_TO_RAW('hi')) AS b, UTL_RAW.CAST_TO_RAW('hi') AS r FROM dual`,
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `D,TS,C,B,R\n2024-01-02 00:00:00,2024-01-02 03:04:05.500,clob text,${Buffer.from("hi").toString("base64")},6869\n`);
});

test("ORACLE_DEFAULT_SCHEMA in the config sets the session's schema", async () => {
  const withSchema = createFakeHome({ ORACLE_DEFAULT_SCHEMA: "SYSTEM" });
  const r = await run(withSchema.home, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS s FROM dual");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "S\nSYSTEM\n");
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
      const r = await cli(sql);
      assert.equal(r.code, 1, `${sql} should fail`);
      assert.ok(r.stderr.startsWith("ORA-01456"), `${sql}: ${JSON.stringify(r.stderr)}`);
    }
    const after = await cli(`SELECT id FROM ${table}`);
    assert.equal(after.stdout, "ID\n1\n", `the table is unchanged (exit ${after.code}: ${after.stderr})`);
  } finally {
    await direct((c) => c.execute(`DROP TABLE ${table}`));
  }
});

test("a SQL error exits 1 with the database's own message, nothing added", async () => {
  const r = await cli("SELECT * FROM this_table_does_not_exist_12345");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.startsWith("ORA-00942"), `nothing in front of the message: ${JSON.stringify(r.stderr)}`);
});

test("a statement with no result set says so instead of printing an empty line", async () => {
  // DDL is not stopped by the read-only transaction (it commits first), so this uses a harmless statement.
  const r = await cli("ALTER SESSION SET NLS_LANGUAGE = 'AMERICAN'");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "statement executed, no result set\n");
});

test("usage errors exit 2, and --help prints the usage", async () => {
  assert.equal((await cli()).code, 2, "no argument and nothing on stdin");
  assert.equal((await cli("SELECT 1 FROM dual", "--limit", "5")).code, 2, "there are no options");
  assert.equal((await cli("SELECT 1 FROM dual", "SELECT 2 FROM dual")).code, 2, "one statement only");
  const help = await cli("--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: opencode-oracle-query/);
});

test("bad credentials exit 3 with the database's own message", async () => {
  const bad = createFakeHome({ ORACLE_PASSWORD: "definitely-wrong-password" });
  const r = await run(bad.home, "SELECT 1 FROM dual");
  assert.equal(r.code, 3);
  assert.ok(r.stderr.startsWith("ORA-01017"), JSON.stringify(r.stderr));
});

test("a missing or broken config file exits 3 and says where it looked", async () => {
  const empty = mkdtempSync(join(tmpdir(), "oracle-nohome-"));
  const missing = await run(empty, "SELECT 1 FROM dual");
  assert.equal(missing.code, 3);
  assert.match(missing.stderr, /Database config file not found[\s\S]*config\.json/);

  const broken = createFakeHome();
  writeFileSync(broken.configPath, "{ this is not json");
  const r = await run(broken.home, "SELECT 1 FROM dual");
  assert.equal(r.code, 3);
  assert.match(r.stderr, /Failed to load database config/);

  writeFileSync(broken.configPath, JSON.stringify({ ORACLE_USER: "only-a-user" }));
  const partial = await run(broken.home, "SELECT 1 FROM dual");
  assert.equal(partial.code, 3);
  assert.match(partial.stderr, /missing one of ORACLE_CONNECT_STRING/);
});

test("the statement can come on stdin, so the shell never touches $, quotes or backticks", async () => {
  // In double quotes bash would turn $b into nothing; on stdin it arrives as written.
  const sql = `SELECT 'a$b' AS "My Col", 'back\\slash' AS bs, 1 AS n
FROM dual
WHERE 'x' = 'x'`;
  const r = await runWithStdin(good.home, sql);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'My Col,BS,N\na$b,back\\slash,1\n');
});

test("a V$ view can be queried through a quoted heredoc", async () => {
  const env = { ...process.env, HOME: good.home, USERPROFILE: good.home };
  const out = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    execFile("bash", ["-c", `node "${CLI}" <<'SQL'\nSELECT COUNT(*) AS n FROM v$version\nSQL`], { env }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number) : 0, stdout, stderr }),
    ),
  );
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /^N\n\d+\n$/);
});

test("an argument and stdin together: the argument wins, stdin is ignored", async () => {
  const r = await runWithStdin(good.home, "SELECT 2 AS two FROM dual", "SELECT 1 AS one FROM dual");
  assert.equal(r.stdout, "ONE\n1\n");
});
