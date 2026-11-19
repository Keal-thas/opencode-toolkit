#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";

// Exit codes: 0 ok, 1 anything went wrong (stderr says what).
const EXIT_FAILURE = 1;

const NAME = "opencode-mysql-query";
const CONFIG_DIR = join(homedir(), ".config", "kealthas-dev", "opencode-mcp-mysql");

// mysql2 has no timeout of any kind by default (createConnection() can hang
// forever against a host that accepts the TCP connection but never responds,
// and query() the same against a connection that goes dark mid-session, e.g.
// blocked on a lock) - both options are ms.
const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;

const HELP = `Usage: ${NAME} <<'SQL'
       <sql, any number of lines>
       SQL

Runs one read-only SQL statement, read from stdin, against the configured MySQL database and prints every row to
stdout as CSV. Nothing is cut off, and errors from the database are printed exactly as the database gave them.

There are no arguments and no options. The statement goes in a heredoc with a quoted delimiter (<<'SQL', as above),
so the shell leaves it alone: a $, a backtick (MySQL quotes identifiers with them), a quote or a backslash all reach
MySQL as written.

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

// The whole of stdin is the statement. There is deliberately no argument form: SQL is full of quotes and
// backticks, so any shell quoting of it is a way to get it wrong.
async function readSql(argv: string[]): Promise<string> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  if (argv.length > 0) usageError("the statement is read from stdin, not given as an argument");
  if (process.stdin.isTTY) usageError("no statement: give it on stdin, with a heredoc");
  const sql = await readStdin();
  if (sql.trim() === "") usageError("the statement on stdin is empty");
  return sql;
}

const SAMPLE_CONFIG = {
  MYSQL_CONNECT_STRING: "mysql://username:password@hostname:3306/database_name",
};

// config.json by default, config-<name>.json when MYSQL_CONFIG_ENV is set. Read on every run, so editing
// it needs nothing restarted. Only a short name is taken from the environment, never a path.
function loadConnectString(): string {
  const envName = process.env.MYSQL_CONFIG_ENV;
  const path = join(CONFIG_DIR, envName ? `config-${envName}.json` : "config.json");
  const sample = `Expected database config file at: ${path}\n${JSON.stringify(SAMPLE_CONFIG, null, 2)}`;
  if (!existsSync(path)) throw new Error(`Database config file not found.\n${sample}`);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw.MYSQL_CONNECT_STRING) throw new Error("missing MYSQL_CONNECT_STRING");
    return raw.MYSQL_CONNECT_STRING;
  } catch (err) {
    throw new Error(`Failed to load database config from ${path}: ${(err as Error).message}\n${sample}`);
  }
}

// Plain text out: a binary column (BLOB, BINARY) as base64, a JSON column as JSON text.
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (Buffer.isBuffer(v)) return v.toString("base64");
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};

function toCsv(columns: string[], rows: unknown[][]): string {
  const esc = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [columns.map(esc).join(","), ...rows.map((r) => r.map((v) => esc(cell(v))).join(","))].join("\n") + "\n";
}

async function main(): Promise<number> {
  const sql = await readSql(process.argv.slice(2));

  let connectString: string;
  try {
    connectString = loadConnectString();
  } catch (err) {
    console.error(`${NAME}: ${(err as Error).message}`);
    return EXIT_FAILURE;
  }

  // One connection per run: nothing a statement leaves open outlives it (closing ends its transaction).
  let connection: mysql.Connection;
  try {
    // mysql2 parses the URI natively. The connect string's own database (if any) is the default one.
    // Dates stay as the text MySQL sent, and big integers stay exact, instead of becoming JS Dates and
    // rounded numbers; rows come as arrays so two columns of the same name both survive.
    connection = await mysql.createConnection({
      uri: connectString,
      connectTimeout: CONNECT_TIMEOUT_MS,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      rowsAsArray: true,
    });
  } catch (err) {
    console.error((err as Error).message); // the database's own words
    return EXIT_FAILURE;
  }

  try {
    // The enforcement mechanism, not just a defense layer: blocks DML (INSERT/UPDATE/DELETE all fail with
    // error 1792, checked against a real MySQL 8 instance) regardless of the connecting account's grants.
    // It does NOT block DDL (CREATE/DROP/ALTER implicitly commit before running, which takes them outside
    // this transaction), so the account's own grants stay the real boundary.
    await connection.query({ sql: "START TRANSACTION READ ONLY", timeout: QUERY_TIMEOUT_MS });
    const [result, fields] = await connection.query({ sql, timeout: QUERY_TIMEOUT_MS });
    await connection.commit();

    if (!Array.isArray(result)) {
      console.log("statement executed, no result set"); // DDL and the like
      return 0;
    }
    process.stdout.write(toCsv((fields ?? []).map((f) => f.name), result as unknown as unknown[][]));
    return 0;
  } catch (err) {
    await connection.rollback().catch(() => {});
    console.error((err as Error).message); // the database's own words, nothing added
    return EXIT_FAILURE;
  } finally {
    await connection.end().catch(() => {});
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
