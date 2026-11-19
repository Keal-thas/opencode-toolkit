// Requires a live MySQL instance - the docker/ sandbox's `mysql` compose
// service (see notes.md's "MySQL test instance" section), started
// separately as a shared fixture. Not mockable: exercises the real mysql2
// round-trip.
// Lives here (not under tests/) so Node's module resolution finds this
// package's own node_modules - run via `npm run build && npm test` after
// `npm install` here (see tests/run-in-container.sh); tsx rather than
// compiled since a test file isn't published.
//
// The package is one command, dist/cli.js, that connects straight to MySQL. Each test runs it the way an
// agent would, with its own fake $HOME holding a config file (os.homedir() reads $HOME at call time, so
// the command needs no test-only escape hatch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import mysql from "mysql2/promise";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "dist", "cli.js");

for (const key of ["MYSQL_HOST", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE"]) {
  if (!process.env[key]) {
    throw new Error(
      `${key} not set - this test needs a live MySQL instance (the docker/ sandbox's ` +
        "mysql service, see notes.md) to build a database config file from, not a bare `node --test` on the host",
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

// Written to the default config.json location - MYSQL_CONFIG_ENV only takes a bare name, never a path.
function createFakeHome(connectString: string = buildConnectString()): { home: string; configPath: string } {
  const home = mkdtempSync(join(tmpdir(), "mysql-test-"));
  const configDir = join(home, ".config", "kealthas-dev", "opencode-mcp-mysql");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ MYSQL_CONNECT_STRING: connectString }));
  return { home, configPath };
}

const good = createFakeHome();

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

// os.homedir() reads USERPROFILE on Windows, HOME elsewhere. stdin is closed at once when there is nothing
// to send, so a run that would read it does not wait.
function runWithStdin(home: string, stdin: string | undefined, ...args: string[]): Promise<CliResult> {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.MYSQL_CONFIG_ENV;
  return new Promise((resolve) => {
    const child = execFile("node", [CLI, ...args], { env, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number) : 0, stdout, stderr });
    });
    child.stdin!.end(stdin ?? "");
  });
}
const run = (home: string, sql: string) => runWithStdin(home, sql);
const cli = (sql: string) => run(good.home, sql);

// DDL and writes for fixtures go straight through the driver: the command is read-only by design.
async function direct<T>(fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
  const c = await mysql.createConnection({ uri: buildConnectString() });
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

test("prints a plain SELECT as CSV", async () => {
  const r = await cli("SELECT 1 AS one, 'hello' AS greeting");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "one,greeting\n1,hello\n");
});

test("a trailing semicolon is accepted", async () => {
  const r = await cli("SELECT 1 AS one;");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "one\n1\n");
});

test("CSV quotes commas, quotes and newlines", async () => {
  const r = await cli(`SELECT 'a,b' AS x, 'say "hi"' AS y, CONCAT('one', CHAR(10 USING utf8mb4), 'two') AS z`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'x,y,z\n"a,b","say ""hi""","one\ntwo"\n');
});

test("nothing is cut off: every row of a large result comes back", async () => {
  const r = await cli(
    "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 50000) SELECT /*+ SET_VAR(cte_max_recursion_depth=100000) */ n FROM t",
  );
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1 + 50000, "header plus every row");
  assert.equal(lines.at(-1), "50000");
  assert.equal(r.stderr, "", "no notice, nothing was left out");
});

test("a pipe closed early (| head) is not an error", async () => {
  const env = { ...process.env, HOME: good.home, USERPROFILE: good.home };
  const sql = "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 200000) SELECT /*+ SET_VAR(cte_max_recursion_depth=300000) */ n FROM t";
  const out = await new Promise<{ stdout: string; stderr: string }>((resolve) =>
    execFile("bash", ["-c", `node "${CLI}" <<'SQL' | head -n 3\n${sql}\nSQL`], { env }, (_e, stdout, stderr) => resolve({ stdout, stderr })),
  );
  assert.equal(out.stdout, "n\n1\n2\n");
  assert.equal(out.stderr, "", "no EPIPE stack trace");
});

test("two columns of the same name both survive", async () => {
  const r = await cli("SELECT 1 AS id, 2 AS id");
  assert.equal(r.stdout, "id,id\n1,2\n");
});

test("dates, big integers and binary columns come back as plain text", async () => {
  const r = await cli(
    "SELECT CAST('2024-01-02 03:04:05' AS DATETIME) AS d, CAST('2024-01-02' AS DATE) AS dd, 9223372036854775807 AS big, CAST('hi' AS BINARY) AS b, JSON_OBJECT('k', 1) AS j",
  );
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `d,dd,big,b,j\n2024-01-02 03:04:05,2024-01-02,9223372036854775807,${Buffer.from("hi").toString("base64")},"{""k"":1}"\n`);
});

test("the shell never touches $, backticks, quotes or backslashes in the statement", async () => {
  // MySQL quotes identifiers with backticks: in an argument bash would run them as a command.
  const sql = "SELECT 'a$b' AS `My Col`, 'back\\\\slash' AS bs, 1 AS n\nWHERE 'x' = 'x'";
  const r = await run(good.home, sql.replace("\nWHERE", " FROM DUAL\nWHERE"));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "My Col,bs,n\na$b,back\\slash,1\n");
});

test("INSERT, UPDATE and DELETE are refused inside the read-only transaction, and change nothing", async () => {
  const table = `ro_dml_test_${Date.now()}`;
  await direct(async (c) => {
    await c.query(`CREATE TABLE ${table} (id INT)`);
    await c.query(`INSERT INTO ${table} VALUES (1)`);
  });
  try {
    for (const sql of [`INSERT INTO ${table} VALUES (2)`, `UPDATE ${table} SET id = 9`, `DELETE FROM ${table}`]) {
      const r = await cli(sql);
      assert.equal(r.code, 1, `${sql} should fail`);
      assert.match(r.stderr, /READ ONLY transaction/, sql);
    }
    const after = await cli(`SELECT id FROM ${table}`);
    assert.equal(after.stdout, "id\n1\n", "the table is unchanged");
  } finally {
    await direct((c) => c.query(`DROP TABLE ${table}`));
  }
});

test("a SQL error exits 1 with the database's own message, nothing added", async () => {
  const r = await cli("SELECT * FROM this_table_does_not_exist_12345");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^Table '.*this_table_does_not_exist_12345' doesn't exist\n$/);
});

test("a statement with no result set says so instead of printing an empty line", async () => {
  const r = await cli("SET @a = 1");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "statement executed, no result set\n");
});

test("usage errors exit 1, and --help prints the usage", async () => {
  assert.equal((await cli("")).code, 1, "an empty statement");
  assert.equal((await cli("  \n ")).code, 1, "only whitespace");
  const withArg = await runWithStdin(good.home, "SELECT 1", "SELECT 2");
  assert.equal(withArg.code, 1, "there is no argument form");
  assert.match(withArg.stderr, /read from stdin, not given as an argument/);
  const help = await runWithStdin(good.home, undefined, "--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: opencode-mysql-query <<'SQL'/);
});

test("bad credentials exit 1 with the database's own message", async () => {
  const bad = createFakeHome(buildConnectString({ password: "definitely-wrong-password" }));
  const r = await run(bad.home, "SELECT 1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^Access denied for user/);
});

test("a missing or broken config file exits 1 and says where it looked", async () => {
  const empty = mkdtempSync(join(tmpdir(), "mysql-nohome-"));
  const missing = await run(empty, "SELECT 1");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Database config file not found[\s\S]*config\.json/);

  const broken = createFakeHome();
  writeFileSync(broken.configPath, "{ this is not json");
  const r = await run(broken.home, "SELECT 1");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Failed to load database config/);

  writeFileSync(broken.configPath, JSON.stringify({ SOMETHING: "else" }));
  const partial = await run(broken.home, "SELECT 1");
  assert.equal(partial.code, 1);
  assert.match(partial.stderr, /missing MYSQL_CONNECT_STRING/);
});
