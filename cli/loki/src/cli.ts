#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Exit codes: 0 ok, 1 anything went wrong (stderr says what).
const EXIT_FAILURE = 1;

const NAME = "opencode-loki-query";
const CONFIG_DIR = join(homedir(), ".config", "kealthas-dev", "opencode-loki-query");

// fetch() has no timeout by default - without this, a Loki/Grafana host
// that accepts the TCP connection but never responds (e.g. stuck behind a
// hung reverse proxy) leaves the request pending forever.
const REQUEST_TIMEOUT_MS = 30_000;

const HELP = `Usage: ${NAME} [options] <<'LOGQL'
       <LogQL query>
       LOGQL
       ${NAME} --labels [options]
       ${NAME} --values LABEL [options]

Runs one LogQL query, read from stdin, against the configured Loki and prints the result. A query prints one line of
JSON per stream (the entries are [nanosecond timestamp, log line] pairs); --labels and --values print one name or
value per line. Errors from Loki are printed exactly as Loki gave them.

The options are Loki's own query parameters, passed through unchanged:
  --since DURATION   how far back from now, e.g. 1h or 30m (Loki's default is a recent window)
  --start TIME       start of the range: RFC3339 with an offset (2026-09-15T10:00:00+08:00) or a unix timestamp
  --end TIME         end of the range, same forms
  --limit N          most log lines to return (Loki's default is 100)
  --labels           list the label names instead of running a query
  --values LABEL     list the values of one label instead of running a query
  --help             this text

The query goes in a heredoc with a quoted delimiter (<<'LOGQL', as above), so the shell leaves it alone: the quotes,
backticks, $ and backslashes of LogQL all reach Loki as written.

Exit codes: 0 ok, 1 failed; stderr says why.`;

function usageError(message: string): never {
  console.error(`${NAME}: ${message}\n\n${HELP}`);
  process.exit(EXIT_FAILURE);
}

interface Options {
  since?: string;
  start?: string;
  end?: string;
  limit?: string;
  labels: boolean;
  values?: string;
}

function parseArgs(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  const opts: Options = { labels: false };
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) usageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--labels") opts.labels = true;
    else if (arg === "--values") opts.values = valueOf(i++, arg);
    else if (arg === "--since") opts.since = valueOf(i++, arg);
    else if (arg === "--start") opts.start = valueOf(i++, arg);
    else if (arg === "--end") opts.end = valueOf(i++, arg);
    else if (arg === "--limit") opts.limit = valueOf(i++, arg);
    else usageError(`unknown argument ${arg} (the query is read from stdin, not given as an argument)`);
  }
  if (opts.labels && opts.values !== undefined) usageError("--labels and --values are separate modes");
  return opts;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// The whole of stdin is the query. There is deliberately no argument form: LogQL is full of quotes, backticks and
// sometimes $, so any shell quoting of it is a way to get it wrong.
async function readQuery(): Promise<string> {
  if (process.stdin.isTTY) usageError("no query: give it on stdin, with a heredoc");
  const query = await readStdin();
  if (query.trim() === "") usageError("the query on stdin is empty");
  return query;
}

interface LokiConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  orgId?: string;
  viaGrafana: boolean;
  grafanaDatasourceId: string;
}

const SAMPLE_CONFIG = {
  LOKI_BASE_URL: "http://192.168.1.100:3100 (no trailing path)",
  LOKI_USERNAME: "username (optional, HTTP basic auth)",
  LOKI_PASSWORD: "password (optional)",
  LOKI_ORG_ID: "tenant-id (optional, multi-tenant Loki / Grafana Cloud-style setups)",
  LOKI_VIA_GRAFANA: "true (optional - set when Loki is only reachable through Grafana's own datasource proxy, not directly; LOKI_BASE_URL becomes Grafana's URL in that case)",
  LOKI_GRAFANA_DATASOURCE_ID: "1 (optional, only used when LOKI_VIA_GRAFANA is true - defaults to 1)",
};

// config.json by default, config-<name>.json when LOKI_CONFIG_ENV is set. Read on every run, so editing it
// needs nothing restarted. Only a short name is taken from the environment, never a path.
// Only LOKI_BASE_URL is required - Loki is commonly reachable unauthenticated on an internal LAN.
function loadConfig(): LokiConfig {
  const envName = process.env.LOKI_CONFIG_ENV;
  const path = join(CONFIG_DIR, envName ? `config-${envName}.json` : "config.json");
  const sample = `Expected Loki config file at: ${path}\n${JSON.stringify(SAMPLE_CONFIG, null, 2)}`;
  if (!existsSync(path)) throw new Error(`Loki config file not found.\n${sample}`);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw.LOKI_BASE_URL) throw new Error("missing required key LOKI_BASE_URL");
    return {
      baseUrl: raw.LOKI_BASE_URL,
      username: raw.LOKI_USERNAME,
      password: raw.LOKI_PASSWORD,
      orgId: raw.LOKI_ORG_ID,
      viaGrafana: raw.LOKI_VIA_GRAFANA === true,
      grafanaDatasourceId: raw.LOKI_GRAFANA_DATASOURCE_ID !== undefined ? String(raw.LOKI_GRAFANA_DATASOURCE_ID) : "1",
    };
  } catch (err) {
    throw new Error(`Failed to load Loki config from ${path}: ${(err as Error).message}\n${sample}`);
  }
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));

  let path: string;
  const params = new URLSearchParams();
  if (opts.labels) path = "/loki/api/v1/labels";
  else if (opts.values !== undefined) path = `/loki/api/v1/label/${encodeURIComponent(opts.values)}/values`;
  else {
    path = "/loki/api/v1/query_range";
    params.set("query", await readQuery());
    if (opts.limit !== undefined) params.set("limit", opts.limit);
  }
  for (const key of ["since", "start", "end"] as const) {
    if (opts[key] !== undefined) params.set(key, opts[key]!);
  }

  let config: LokiConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`${NAME}: ${(err as Error).message}`);
    return EXIT_FAILURE;
  }

  const effectivePath = config.viaGrafana ? `/api/datasources/proxy/${config.grafanaDatasourceId}${path}` : path;
  const url = new URL(effectivePath, config.baseUrl);
  url.search = params.toString();

  const headers: Record<string, string> = {};
  if (config.username || config.password) {
    headers.Authorization = `Basic ${Buffer.from(`${config.username ?? ""}:${config.password ?? ""}`).toString("base64")}`;
  }
  if (config.orgId) headers["X-Scope-OrgID"] = config.orgId;

  let response: Response;
  try {
    // Manual redirect handling: a Grafana instance rejecting the request (missing/expired auth, or
    // LOKI_VIA_GRAFANA off when it should be on) responds with a 302 to its own login page, not a 401. Node's
    // fetch follows that by default, landing on the login page's HTML with a misleadingly successful 200.
    response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    console.error((err as Error).message);
    return EXIT_FAILURE;
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "(no Location header)";
    const hint = config.viaGrafana
      ? "check LOKI_USERNAME/LOKI_PASSWORD (must be a real Grafana user's Basic Auth) and LOKI_GRAFANA_DATASOURCE_ID"
      : "if this Loki is only reachable through Grafana's datasource proxy, set LOKI_VIA_GRAFANA: true (see README's Configuration section)";
    console.error(`${NAME}: the request was redirected (${response.status}) to ${location} instead of returning data - ${hint}.`);
    return EXIT_FAILURE;
  }

  // Text first, not response.json() - Loki's error responses aren't guaranteed to be JSON.
  const text = await response.text();
  if (!response.ok) {
    console.error(text.trim() || `HTTP ${response.status} ${response.statusText}`); // Loki's own words
    return EXIT_FAILURE;
  }

  // Only the result is printed: the envelope and the statistics block (a few KB per query) are not data.
  const data = (text ? JSON.parse(text) : null)?.data;
  const lines = Array.isArray(data) ? data : data?.result;
  if (Array.isArray(lines)) {
    for (const item of lines) console.log(typeof item === "string" ? item : JSON.stringify(item));
  } else {
    console.log(JSON.stringify(lines ?? data ?? null));
  }
  return 0;
}

// `... | head` closes the pipe early; that is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`${NAME}: ${(err as Error).message}`);
    process.exitCode = EXIT_FAILURE;
  },
);
