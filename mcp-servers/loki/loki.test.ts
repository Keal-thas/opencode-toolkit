// Requires a live Loki instance reachable via LOKI_BASE_URL - the docker/
// sandbox's `loki` compose service (see notes.md's "Loki test instance"
// section), a shared fixture started separately. Not mockable: exercises the
// real Loki HTTP query API round-trip. Lives here (not under tests/) so Node's
// module resolution finds this package's own node_modules - run via
// `npm run build && npm test` after `npm install` here (see
// tests/run-in-container.sh); tsx rather than compiled since a test file isn't
// published.
//
// The package is one command, dist/cli.js, that talks straight to Loki. Each test runs it the way an agent
// would, with its own fake $HOME holding a config file (os.homedir() reads $HOME at call time, so the command
// needs no test-only escape hatch). Test data is pushed to Loki's push API, independent of the command.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "dist", "cli.js");

if (!process.env.LOKI_BASE_URL) {
  throw new Error(
    "LOKI_BASE_URL not set - this test needs a live Loki instance (the docker/ sandbox's " +
      "loki service, see notes.md) to build a config file from, not a bare `node --test` on the host",
  );
}

// Written to the default config.json location - LOKI_CONFIG_ENV only takes a bare name, never a path.
function createFakeHome(config?: Record<string, unknown>): { home: string; configPath: string } {
  const home = mkdtempSync(join(tmpdir(), "loki-test-"));
  const configDir = join(home, ".config", "kealthas-dev", "opencode-mcp-loki");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      config ?? {
        LOKI_BASE_URL: process.env.LOKI_BASE_URL,
        LOKI_USERNAME: process.env.LOKI_USERNAME,
        LOKI_PASSWORD: process.env.LOKI_PASSWORD,
        LOKI_ORG_ID: process.env.LOKI_ORG_ID,
      },
    ),
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
  delete env.LOKI_CONFIG_ENV;
  return new Promise((resolve) => {
    const child = execFile("node", [CLI, ...args], { env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number) : 0, stdout, stderr });
    });
    child.stdin!.end(stdin ?? "");
  });
}
const query = (logql: string, ...args: string[]) => runWithStdin(good.home, logql, ...args);

// A fresh label value per run, not fixed - this Loki instance is a shared fixture, so a fixed value could
// collide with a concurrent test run.
const app = `loki_test_${Date.now()}`;
const line1 = `hello from the loki test ${Date.now()}`;
const line2 = `price is a$b and \`ticks\` and back\\slash ${Date.now()}`;

before(async () => {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const response = await fetch(new URL("/loki/api/v1/push", process.env.LOKI_BASE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      streams: [{ stream: { app, source: "loki-test" }, values: [[String(nowNs), line1], [String(nowNs + 1_000n), line2]] }],
    }),
  });
  if (!response.ok) throw new Error(`Seeding Loki failed: ${response.status} ${await response.text()}`);
});

// One JSON object per stream; the entries inside are [ns timestamp, line].
const entries = (stdout: string): string[] =>
  stdout.trim().split("\n").filter(Boolean).flatMap((l) => (JSON.parse(l).values as [string, string][]).map(([, text]) => text));

test("a query prints one line of JSON per stream, with the log lines in it", async () => {
  const r = await query(`{app="${app}"}`, "--since", "1h");
  assert.equal(r.code, 0, r.stderr);
  const streams = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(streams.length, 1);
  assert.equal(streams[0].stream.app, app);
  assert.deepEqual(entries(r.stdout).sort(), [line1, line2].sort());
  assert.doesNotMatch(r.stdout, /"stats"|"status"/, "only the result, not Loki's envelope or statistics");
});

test("--start and --end are passed through as given", async () => {
  const start = new Date(Date.now() - 5 * 60_000).toISOString();
  const end = new Date(Date.now() + 5 * 60_000).toISOString();
  const inside = await query(`{app="${app}"}`, "--start", start, "--end", end);
  assert.equal(inside.code, 0, inside.stderr);
  assert.equal(entries(inside.stdout).length, 2);

  const past = await query(`{app="${app}"}`, "--start", new Date(Date.now() - 3 * 3_600_000).toISOString(), "--end", new Date(Date.now() - 2 * 3_600_000).toISOString());
  assert.equal(past.code, 0, past.stderr);
  assert.equal(past.stdout.trim(), "", "nothing in a window two hours back");
});

test("--limit is Loki's own limit", async () => {
  const r = await query(`{app="${app}"}`, "--since", "1h", "--limit", "1");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(entries(r.stdout).length, 1);
});

test("the query reaches Loki untouched, with $, backticks and a backslash in it", async () => {
  // In an argument bash would expand $b and run the backticks; on stdin they arrive as written.
  const r = await query('{app="' + app + '"} |= "a$b"', "--since", "1h");
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(entries(r.stdout), [line2]);

  const env = { ...process.env, HOME: good.home, USERPROFILE: good.home };
  const viaHeredoc = await new Promise<string>((resolve) =>
    execFile("bash", ["-c", `node "${CLI}" --since 1h <<'LOGQL'\n{app="${app}"} |= \`ticks\`\nLOGQL`], { env }, (_e, stdout) => resolve(stdout)),
  );
  assert.deepEqual(entries(viaHeredoc), [line2]);
});

test("--labels lists the label names, one per line", async () => {
  const r = await runWithStdin(good.home, undefined, "--labels", "--since", "1h");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.trim().split("\n").includes("app"), r.stdout);
});

test("--values lists the values of one label, one per line", async () => {
  const r = await runWithStdin(good.home, undefined, "--values", "app", "--since", "1h");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.trim().split("\n").includes(app), r.stdout);
});

test("a malformed query exits 1 with Loki's own message, nothing added", async () => {
  const r = await query("{app=", "--since", "1h");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^parse error at line 1, col 6: syntax error: unexpected \$end, expecting STRING\n$/);
});

test("a query that matches nothing prints nothing and succeeds", async () => {
  const r = await query(`{app="${app}_nope"}`, "--since", "1h");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("usage errors exit 1, and --help prints the usage", async () => {
  assert.equal((await query("")).code, 1, "an empty query");
  assert.equal((await query("  \n ")).code, 1, "only whitespace");
  const withArg = await runWithStdin(good.home, '{app="x"}', '{app="y"}');
  assert.equal(withArg.code, 1, "there is no argument form");
  assert.match(withArg.stderr, /read from stdin, not given as an argument|unknown argument/);
  assert.equal((await runWithStdin(good.home, undefined, "--labels", "--values", "app")).code, 1, "two modes at once");
  const help = await runWithStdin(good.home, undefined, "--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: opencode-loki-query/);
});

test("an unreachable Loki exits 1 with the network error", async () => {
  const dead = createFakeHome({ LOKI_BASE_URL: "http://127.0.0.1:1" });
  const r = await runWithStdin(dead.home, '{app="x"}', "--since", "1h");
  assert.equal(r.code, 1);
  assert.ok(r.stderr.trim().length > 0);
});

test("a missing or broken config file exits 1 and says where it looked", async () => {
  const empty = mkdtempSync(join(tmpdir(), "loki-nohome-"));
  const missing = await runWithStdin(empty, '{app="x"}');
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Loki config file not found[\s\S]*config\.json/);

  const broken = createFakeHome();
  writeFileSync(broken.configPath, "{ this is not json");
  const r = await runWithStdin(broken.home, '{app="x"}');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Failed to load Loki config/);

  writeFileSync(broken.configPath, JSON.stringify({ LOKI_USERNAME: "only-a-user" }));
  const partial = await runWithStdin(broken.home, '{app="x"}');
  assert.equal(partial.code, 1);
  assert.match(partial.stderr, /missing required key LOKI_BASE_URL/);
});

// A throwaway HTTP server standing in for Grafana: records each request, and answers as told.
async function withFakeGrafana<T>(respond: (res: http.ServerResponse) => void, fn: (baseUrl: string, seen: http.IncomingMessage[]) => Promise<T>): Promise<T> {
  const seen: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req);
    respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("LOKI_VIA_GRAFANA sends the request through Grafana's datasource proxy, with Basic Auth and the org id", async () => {
  await withFakeGrafana(
    (res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "success", data: { resultType: "streams", result: [] } })),
    async (baseUrl, seen) => {
      const home = createFakeHome({ LOKI_BASE_URL: baseUrl, LOKI_VIA_GRAFANA: true, LOKI_GRAFANA_DATASOURCE_ID: 7, LOKI_USERNAME: "u", LOKI_PASSWORD: "p", LOKI_ORG_ID: "tenant-1" });
      const r = await runWithStdin(home.home, '{app="x"}', "--since", "1h");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(seen.length, 1);
      assert.match(seen[0].url!, /^\/api\/datasources\/proxy\/7\/loki\/api\/v1\/query_range\?/);
      assert.equal(seen[0].headers.authorization, `Basic ${Buffer.from("u:p").toString("base64")}`);
      assert.equal(seen[0].headers["x-scope-orgid"], "tenant-1");
    },
  );
});

test("a redirect (Grafana's login page) is reported, not followed", async () => {
  await withFakeGrafana(
    (res) => res.writeHead(302, { Location: "/login" }).end(),
    async (baseUrl) => {
      const home = createFakeHome({ LOKI_BASE_URL: baseUrl });
      const r = await runWithStdin(home.home, '{app="x"}', "--since", "1h");
      assert.equal(r.code, 1);
      assert.match(r.stderr, /redirected \(302\) to \/login[\s\S]*LOKI_VIA_GRAFANA/);
    },
  );
});

test("an error body from Loki or Grafana is printed as it came", async () => {
  await withFakeGrafana(
    (res) => res.writeHead(500, { "Content-Type": "text/plain" }).end("too many outstanding requests"),
    async (baseUrl) => {
      const home = createFakeHome({ LOKI_BASE_URL: baseUrl });
      const r = await runWithStdin(home.home, '{app="x"}', "--since", "1h");
      assert.equal(r.code, 1);
      assert.equal(r.stderr, "too many outstanding requests\n");
    },
  );
});
