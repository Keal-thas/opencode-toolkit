// Requires a live Redis instance - the docker/ sandbox's `redis` compose service (see notes.md's "Redis test
// instance" section), started separately as a shared fixture, with the ACL users from docker/redis.conf. Not
// mockable: exercises the real node-redis round-trip, and the read-only account's NOPERM answers.
// Lives here (not under tests/) so Node's module resolution finds this package's own node_modules - run via
// `npm run build && npm test` after `npm install` here (see tests/run-in-container.sh); tsx rather than
// compiled since a test file isn't published.
//
// The package is one command, dist/cli.js, that connects straight to Redis. Each test runs it the way an agent
// would, with its own fake $HOME holding a config file (os.homedir() reads $HOME at call time, so the command
// needs no test-only escape hatch). Data is seeded, and writes are checked, over a second connection as the
// sandbox's unrestricted default user, so the test does not just trust the command's own report.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createClient } from "redis";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "dist", "cli.js");

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? "6379");

// Written to the default config.json location - REDIS_CONFIG_ENV only takes a bare name, never a path.
function createFakeHome(overrides?: Record<string, unknown>): { home: string; configPath: string } {
  const home = mkdtempSync(join(tmpdir(), "redis-test-"));
  const configDir = join(home, ".config", "kealthas-dev", "opencode-redis-query");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ REDIS_HOST, REDIS_PORT, REDIS_USERNAME: "readonlyuser", REDIS_PASSWORD: "readonlypass", ...overrides }),
  );
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
  delete env.REDIS_CONFIG_ENV;
  return new Promise((resolve) => {
    const child = execFile("node", [CLI, ...args], { env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number) : 0, stdout, stderr });
    });
    child.stdin!.end(stdin ?? "");
  });
}
const cli = (command: string) => runWithStdin(good.home, command);

let seed: ReturnType<typeof createClient>;
const prefix = `redis-test-${Date.now()}`;
const keys: string[] = [];
const key = (name: string) => {
  const k = `${prefix}:${name}`;
  keys.push(k);
  return k;
};

before(async () => {
  seed = createClient({ socket: { host: REDIS_HOST, port: REDIS_PORT } });
  await seed.connect();
});

after(async () => {
  if (keys.length) await seed.del(keys);
  await seed.quit();
});

test("GET prints the value", async () => {
  const k = key("string");
  await seed.set(k, "hello-from-seed");
  const r = await cli(`GET ${k}`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "hello-from-seed\n");
});

test("a missing value is an empty line, and succeeds", async () => {
  const r = await cli(`GET ${prefix}:definitely-missing`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "\n");
});

test("an integer reply is printed as a number", async () => {
  const k = key("list-count");
  await seed.rPush(k, ["a", "b", "c"]);
  assert.equal((await cli(`LLEN ${k}`)).stdout, "3\n");
});

test("an array reply is one element per line, and a hash is field then value", async () => {
  const list = key("list");
  await seed.rPush(list, ["one", "two", "three"]);
  assert.equal((await cli(`LRANGE ${list} 0 -1`)).stdout, "one\ntwo\nthree\n");

  const hash = key("hash");
  await seed.hSet(hash, { f1: "v1", f2: "v2" });
  const r = await cli(`HGETALL ${hash}`);
  assert.deepEqual(r.stdout.trim().split("\n").sort(), ["f1", "f2", "v1", "v2"]);
});

test("a nested reply is flattened one value per line", async () => {
  const k = key("zset");
  await seed.zAdd(k, [{ score: 1, value: "a" }, { score: 2, value: "b" }]);
  const r = await cli(`ZRANGE ${k} 0 -1 WITHSCORES`);
  assert.equal(r.stdout, "a\n1\nb\n2\n");
});

test("quotes are read the way redis-cli reads them", async () => {
  const k = key("key with spaces");
  await seed.set(k, "line1\nline2");
  const r = await cli(`GET "${k}"`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "line1\nline2\n");

  const single = await cli(`GET '${k}'`);
  assert.equal(single.stdout, "line1\nline2\n");

  const escapes = key("escapes");
  await seed.set(escapes, "a\tb");
  assert.equal((await cli(`GET "${escapes}"`)).stdout, "a\tb\n");
  assert.equal((await cli(`EXISTS "${prefix}:\\x6dissing"`)).stdout, "0\n", "\\x6d is an m, so the key does not exist");
});

test("the shell never touches $, backticks or backslashes in the command", async () => {
  const k = key("a$b");
  await seed.set(k, "dollar");
  const r = await cli(`GET ${k}`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "dollar\n");

  const env = { ...process.env, HOME: good.home, USERPROFILE: good.home };
  const viaHeredoc = await new Promise<string>((resolve) =>
    execFile("bash", ["-c", `node "${CLI}" <<'REDIS'\nGET ${k}\nREDIS`], { env }, (_e, stdout) => resolve(stdout)),
  );
  assert.equal(viaHeredoc, "dollar\n");
});

test("SCAN lists keys: the cursor first, then one key per line", async () => {
  const k = key("scanned");
  await seed.set(k, "x");
  const r = await cli(`SCAN 0 MATCH ${prefix}:scanned COUNT 100000`);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^\d+$/, "the cursor");
  assert.ok(lines.includes(k), r.stdout);
});

test("a command outside +@read, such as INFO, is refused by the account, with Redis's own message", async () => {
  const r = await cli("INFO server");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^NOPERM User readonlyuser has no permissions to run the 'info' command\n$/);
});

test("the read-only account is refused a write, with Redis's own message, and nothing is written", async () => {
  const k = key("write");
  const r = await cli(`SET ${k} nope`);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^NOPERM User readonlyuser has no permissions to run the 'set' command\n$/);
  assert.equal(await seed.exists(k), 0);
  for (const command of [`DEL ${k}`, "FLUSHALL", `EVAL "return 1" 0`]) {
    const denied = await cli(command);
    assert.equal(denied.code, 1, command);
    assert.match(denied.stderr, /^NOPERM/, command);
  }
});

test("an unknown command exits 1 with Redis's own message", async () => {
  const r = await cli("NOTACOMMAND x");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^ERR unknown command/);
});

test("a pipe closed early (| head) is not an error", async () => {
  const k = key("long-list");
  await seed.rPush(k, Array.from({ length: 20000 }, (_, i) => String(i)));
  const env = { ...process.env, HOME: good.home, USERPROFILE: good.home };
  const out = await new Promise<{ stdout: string; stderr: string }>((resolve) =>
    execFile("bash", ["-c", `node "${CLI}" <<'REDIS' | head -n 3\nLRANGE ${k} 0 -1\nREDIS`], { env }, (_e, stdout, stderr) => resolve({ stdout, stderr })),
  );
  assert.equal(out.stdout, "0\n1\n2\n");
  assert.equal(out.stderr, "", "no EPIPE stack trace");
});

test("usage errors exit 1, and --help prints the usage", async () => {
  assert.equal((await cli("")).code, 1, "an empty command");
  assert.equal((await cli("  \n ")).code, 1, "only whitespace");
  const withArg = await runWithStdin(good.home, "GET x", "GET y");
  assert.equal(withArg.code, 1, "there is no argument form");
  assert.match(withArg.stderr, /read from stdin, not given as an argument/);
  const unbalanced = await cli('GET "unclosed');
  assert.equal(unbalanced.code, 1);
  assert.match(unbalanced.stderr, /unbalanced double quotes/);
  const help = await runWithStdin(good.home, undefined, "--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: opencode-redis-query <<'REDIS'/);
});

test("a wrong password exits 1 with Redis's own message", async () => {
  const bad = createFakeHome({ REDIS_PASSWORD: "definitely-wrong-password" });
  const r = await runWithStdin(bad.home, "GET x");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^WRONGPASS/);
});

test("an unreachable Redis exits 1 at once, without retrying", async () => {
  const dead = createFakeHome({ REDIS_HOST: "127.0.0.1", REDIS_PORT: 1 });
  const started = Date.now();
  const r = await runWithStdin(dead.home, "GET x");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.trim().length > 0);
  assert.ok(Date.now() - started < 8000, "it did not sit retrying");
});

test("a missing or broken config file exits 1 and says where it looked", async () => {
  const empty = mkdtempSync(join(tmpdir(), "redis-nohome-"));
  const missing = await runWithStdin(empty, "GET x");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Redis config file not found[\s\S]*config\.json/);

  const broken = createFakeHome();
  writeFileSync(broken.configPath, "{ this is not json");
  const r = await runWithStdin(broken.home, "GET x");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Failed to load Redis config/);

  writeFileSync(broken.configPath, JSON.stringify({ REDIS_PORT: 6379 }));
  const partial = await runWithStdin(broken.home, "GET x");
  assert.equal(partial.code, 1);
  assert.match(partial.stderr, /missing required key REDIS_HOST/);
});
