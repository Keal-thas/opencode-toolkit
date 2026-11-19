#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "redis";

// Exit codes: 0 ok, 1 anything went wrong (stderr says what).
const EXIT_FAILURE = 1;

const NAME = "opencode-redis-query";
const CONFIG_DIR = join(homedir(), ".config", "kealthas-dev", "opencode-mcp-redis");

// Without these a host that accepts the TCP connection but never answers, or a blocking command with no
// timeout (BLPOP key 0, SUBSCRIBE), would leave the run waiting forever.
const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;

const HELP = `Usage: ${NAME} <<'REDIS'
       <one Redis command>
       REDIS

Runs one Redis command, read from stdin, against the configured Redis and prints the reply to stdout, the way
redis-cli --raw does: a string or number as it is, a missing value as an empty line, an array one element per line
(nested arrays flattened). Errors from Redis are printed exactly as Redis gave them.

The command is written as in redis-cli: words separated by spaces, "double quotes" (with \\n, \\xHH and \\" escapes)
or 'single quotes' around a word that contains spaces. It goes in a heredoc with a quoted delimiter (<<'REDIS', as
above), so the shell leaves it alone.

There are no arguments and no options. Nothing is blocked here: what the command may do is decided by the Redis
account in the config, so give it a read-only one (+@read -@write).

Exit codes: 0 ok, 1 failed; stderr says why.`;

function usageError(message: string): never {
  console.error(`${NAME}: ${message}\n\n${HELP}`);
  process.exit(EXIT_FAILURE);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Splits a command line the way redis-cli does (sdssplitargs): whitespace between words, double quotes with
// backslash escapes, single quotes where only \\' is special.
function splitArgs(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    let word = "";
    if (line[i] === '"') {
      i++;
      for (;;) {
        if (i >= n) throw new Error("unbalanced double quotes");
        const c = line[i];
        if (c === "\\" && i + 1 < n) {
          const e = line[i + 1];
          if (e === "x" && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
            word += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }
          word += { n: "\n", r: "\r", t: "\t", b: "\b", a: "\x07" }[e] ?? e;
          i += 2;
        } else if (c === '"') {
          i++;
          if (i < n && !/\s/.test(line[i])) throw new Error("a closing quote must be followed by a space");
          break;
        } else {
          word += c;
          i++;
        }
      }
    } else if (line[i] === "'") {
      i++;
      for (;;) {
        if (i >= n) throw new Error("unbalanced single quotes");
        const c = line[i];
        if (c === "\\" && line[i + 1] === "'") {
          word += "'";
          i += 2;
        } else if (c === "'") {
          i++;
          if (i < n && !/\s/.test(line[i])) throw new Error("a closing quote must be followed by a space");
          break;
        } else {
          word += c;
          i++;
        }
      }
    } else {
      while (i < n && !/\s/.test(line[i])) word += line[i++];
    }
    args.push(word);
  }
  return args;
}

// The whole of stdin is the command. There is deliberately no argument form: a Redis command is full of quotes,
// so any shell quoting of it is a way to get it wrong.
async function readCommand(argv: string[]): Promise<string[]> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  if (argv.length > 0) usageError("the command is read from stdin, not given as an argument");
  if (process.stdin.isTTY) usageError("no command: give it on stdin, with a heredoc");
  const text = await readStdin();
  if (text.trim() === "") usageError("the command on stdin is empty");
  try {
    const args = splitArgs(text);
    if (args.length === 0) usageError("the command on stdin is empty");
    return args;
  } catch (err) {
    return usageError(`cannot read the command: ${(err as Error).message}`);
  }
}

interface RedisConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls: boolean;
}

const SAMPLE_CONFIG = {
  REDIS_HOST: "hostname",
  REDIS_PORT: "6379 (optional, defaults to 6379)",
  REDIS_USERNAME: "readonlyuser (optional - an ACL user)",
  REDIS_PASSWORD: "password (optional)",
  REDIS_DB: "0 (optional, the database number)",
  REDIS_TLS: "false (optional)",
};

// config.json by default, config-<name>.json when REDIS_CONFIG_ENV is set. Read on every run, so editing
// it needs nothing restarted. Only a short name is taken from the environment, never a path.
function loadConfig(): RedisConfig {
  const envName = process.env.REDIS_CONFIG_ENV;
  const path = join(CONFIG_DIR, envName ? `config-${envName}.json` : "config.json");
  const sample = `Expected Redis config file at: ${path}\n${JSON.stringify(SAMPLE_CONFIG, null, 2)}`;
  if (!existsSync(path)) throw new Error(`Redis config file not found.\n${sample}`);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw.REDIS_HOST) throw new Error("missing required key REDIS_HOST");
    const port = raw.REDIS_PORT === undefined ? 6379 : Number(raw.REDIS_PORT);
    if (!Number.isInteger(port) || port <= 0) throw new Error(`REDIS_PORT must be a positive integer, got: ${JSON.stringify(raw.REDIS_PORT)}`);
    const db = raw.REDIS_DB === undefined ? undefined : Number(raw.REDIS_DB);
    if (db !== undefined && (!Number.isInteger(db) || db < 0)) throw new Error(`REDIS_DB must be a non-negative integer, got: ${JSON.stringify(raw.REDIS_DB)}`);
    return { host: raw.REDIS_HOST, port, username: raw.REDIS_USERNAME, password: raw.REDIS_PASSWORD, db, tls: raw.REDIS_TLS === true };
  } catch (err) {
    throw new Error(`Failed to load Redis config from ${path}: ${(err as Error).message}\n${sample}`);
  }
}

// One line per value, the way redis-cli --raw prints it: nested arrays flattened, a missing value is an empty line.
function render(reply: unknown, out: string[]): void {
  if (Array.isArray(reply)) {
    for (const item of reply) render(item, out);
  } else if (reply === null || reply === undefined) {
    out.push("");
  } else if (Buffer.isBuffer(reply)) {
    out.push(reply.toString("utf8"));
  } else if (typeof reply === "object") {
    out.push(JSON.stringify(reply));
  } else {
    out.push(String(reply));
  }
}

async function main(): Promise<number> {
  const command = await readCommand(process.argv.slice(2));

  let config: RedisConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`${NAME}: ${(err as Error).message}`);
    return EXIT_FAILURE;
  }

  // reconnectStrategy: false, so an unreachable host fails the run at once instead of retrying forever.
  const client = createClient({
    socket: { host: config.host, port: config.port, tls: config.tls as true, connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false },
    username: config.username,
    password: config.password,
    database: config.db,
  });
  client.on("error", () => {}); // a failed connect rejects connect(); this only keeps a late socket error from becoming an uncaught one

  try {
    await client.connect();
  } catch (err) {
    console.error((err as Error).message);
    return EXIT_FAILURE;
  }

  try {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no reply within ${COMMAND_TIMEOUT_MS / 1000} seconds (a blocking command such as BLPOP or SUBSCRIBE waits for data)`)), COMMAND_TIMEOUT_MS);
    });
    const reply = await Promise.race([client.sendCommand(command), timeout]).finally(() => clearTimeout(timer));
    const out: string[] = [];
    render(reply, out);
    process.stdout.write(out.map((l) => `${l}\n`).join(""));
    return 0;
  } catch (err) {
    console.error((err as Error).message); // Redis's own words, nothing added
    return EXIT_FAILURE;
  } finally {
    client.disconnect().catch(() => {});
  }
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
