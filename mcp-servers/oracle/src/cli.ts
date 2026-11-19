#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import oracledb from "oracledb";

// Exit codes: 0 ok, 1 the SQL failed, 2 usage error, 3 the query could not run
// at all (cannot connect, bad credentials, unreadable config, timed out).
const EXIT_SQL = 1;
const EXIT_USAGE = 2;
const EXIT_UNAVAILABLE = 3;

const NAME = "opencode-oracle-query";
const CONFIG_DIR = join(homedir(), ".config", "kealthas-dev", "opencode-mcp-oracle");

// oracledb has no timeout of any kind by default (getConnection() can hang
// forever against a host that accepts the TCP connection but never
// responds, and execute() the same against a connection that goes dark
// mid-session, e.g. blocked on a lock) - both units are oracledb's own,
// not a shared convention: connectTimeout is seconds, callTimeout is ms.
const CONNECT_TIMEOUT_SECONDS = 10;
const CALL_TIMEOUT_MS = 30_000;

const HELP = `Usage: ${NAME} "<sql>"
       ${NAME} <<'SQL'
       <sql, any number of lines>
       SQL

Runs one read-only SQL statement against the configured Oracle database and prints every row to stdout as CSV.
Nothing is cut off, and errors from the database are printed exactly as the database gave them.

Give the statement as one quoted argument, or on stdin. Prefer stdin with a quoted heredoc delimiter (<<'SQL', as above)
when the SQL contains $, backticks, quotes or backslashes: inside double quotes the shell expands $, so v$session would
reach Oracle as v.

Exit codes: 0 ok, 1 SQL error, 2 usage error, 3 could not run (cannot connect, bad credentials, bad config, timeout).`;

function usageError(message: string): never {
  console.error(`${NAME}: ${message}\n\n${HELP}`);
  process.exit(EXIT_USAGE);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// One quoted argument, or the whole of stdin when there is no argument and stdin is not a terminal.
async function readSql(argv: string[]): Promise<string> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  if (argv.length > 1) usageError("give exactly one SQL statement, quoted");
  const sql = argv.length === 1 ? argv[0] : process.stdin.isTTY ? "" : await readStdin();
  if (sql.trim() === "") usageError("give a SQL statement, as one quoted argument or on stdin");
  return sql;
}

interface DatabaseConfig {
  connectString: string;
  user: string;
  password: string;
  schema?: string;
}

const SAMPLE_CONFIG = {
  ORACLE_CONNECT_STRING: "hostname:1521/service_name (Easy Connect or TNS, either works)",
  ORACLE_USER: "username",
  ORACLE_PASSWORD: "password",
  ORACLE_DEFAULT_SCHEMA: "SCHEMA_NAME (optional; exact case as Oracle stores it - normally UPPERCASE, e.g. HR not hr)",
};

// config.json by default, config-<name>.json when ORACLE_CONFIG_ENV is set. Read on every run,
// so editing it needs nothing restarted. Only a short name is taken from the environment, never a path.
function loadDatabaseConfig(): DatabaseConfig {
  const envName = process.env.ORACLE_CONFIG_ENV;
  const path = join(CONFIG_DIR, envName ? `config-${envName}.json` : "config.json");
  const sample = `Expected database config file at: ${path}\n${JSON.stringify(SAMPLE_CONFIG, null, 2)}`;
  if (!existsSync(path)) throw new Error(`Database config file not found.\n${sample}`);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw.ORACLE_CONNECT_STRING || !raw.ORACLE_USER || !raw.ORACLE_PASSWORD) {
      throw new Error("missing one of ORACLE_CONNECT_STRING, ORACLE_USER, ORACLE_PASSWORD");
    }
    return { connectString: raw.ORACLE_CONNECT_STRING, user: raw.ORACLE_USER, password: raw.ORACLE_PASSWORD, schema: raw.ORACLE_DEFAULT_SCHEMA };
  } catch (err) {
    throw new Error(`Failed to load database config from ${path}: ${(err as Error).message}\n${sample}`);
  }
}

// Everything comes back as plain text or numbers, never as a driver object:
// - CLOB/NCLOB as strings and BLOB as base64 (Lob objects hold the connection and can't be printed)
// - RAW as hex
// - DATE/TIMESTAMP as "YYYY-MM-DD HH24:MI:SS[.mmm]" wall-clock text. The driver hands these over as JS Dates built
//   in this process's time zone, so the local getters give back the stored wall-clock value; a JS Date holds
//   milliseconds, so finer fractions are cut. Time-zone types become an ISO instant.
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const wallClock = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
oracledb.fetchTypeHandler = (meta) => {
  const t = meta.dbType;
  if (t === oracledb.DB_TYPE_CLOB || t === oracledb.DB_TYPE_NCLOB) return { type: oracledb.STRING };
  if (t === oracledb.DB_TYPE_BLOB) {
    return { type: oracledb.BUFFER, converter: (val) => (val as Buffer | null)?.toString("base64") ?? null };
  }
  if (t === oracledb.DB_TYPE_RAW) return { type: oracledb.STRING };
  if (t === oracledb.DB_TYPE_DATE) return { converter: (val) => (val instanceof Date ? wallClock(val) : val) };
  if (t === oracledb.DB_TYPE_TIMESTAMP) {
    return { converter: (val) => (val instanceof Date ? wallClock(val) + (val.getMilliseconds() ? `.${pad(val.getMilliseconds(), 3)}` : "") : val) };
  }
  if (t === oracledb.DB_TYPE_TIMESTAMP_TZ || t === oracledb.DB_TYPE_TIMESTAMP_LTZ) {
    return { converter: (val) => (val instanceof Date ? val.toISOString() : val) };
  }
  return undefined;
};

// A trailing ";" is a SQL*Plus convention; the server rejects it (ORA-00911). Agents add one by habit.
function stripTrailingSemicolon(sql: string): string {
  return /^\s*(select|with)\b/i.test(sql) ? sql.replace(/;\s*$/, "") : sql;
}

const cell = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function toCsv(columns: string[], rows: unknown[][]): string {
  const esc = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [columns.map(esc).join(","), ...rows.map((r) => r.map((v) => esc(cell(v))).join(","))].join("\n") + "\n";
}

async function main(): Promise<number> {
  const sql = await readSql(process.argv.slice(2));

  let config: DatabaseConfig;
  try {
    config = loadDatabaseConfig();
  } catch (err) {
    console.error(`${NAME}: ${(err as Error).message}`);
    return EXIT_UNAVAILABLE;
  }

  // One connection per run: nothing a statement leaves open outlives it (closing rolls back).
  let connection: oracledb.Connection;
  try {
    connection = await oracledb.getConnection({
      connectString: config.connectString,
      user: config.user,
      password: config.password,
      connectTimeout: CONNECT_TIMEOUT_SECONDS,
    });
  } catch (err) {
    console.error((err as Error).message); // the database's own words
    return EXIT_UNAVAILABLE;
  }
  connection.callTimeout = CALL_TIMEOUT_MS;

  try {
    // ALTER SESSION commits implicitly, and SET TRANSACTION must be the first
    // statement of a transaction, so all session setup comes first.
    // No bind variables for identifiers in ALTER SESSION: the schema is interpolated, which is fine
    // for a caller that may run arbitrary SQL anyway.
    if (config.schema) await connection.execute(`ALTER SESSION SET CURRENT_SCHEMA = "${config.schema}"`);
    // So a date literal in the SQL ('2024-01-02 03:04:05') converts the way the output prints.
    await connection.execute(
      `ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS' NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF' NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZR'`,
    );
    // DML is then refused by Oracle itself (ORA-01456), even for an account that holds write grants.
    // DDL is not covered (it commits first), so the account's own grants stay the real boundary.
    await connection.execute("SET TRANSACTION READ ONLY");

    const result = await connection.execute(stripTrailingSemicolon(sql), [], { outFormat: oracledb.OUT_FORMAT_ARRAY });

    if (!result.metaData) {
      console.log("statement executed, no result set"); // DDL and the like
      return 0;
    }
    process.stdout.write(toCsv(result.metaData.map((c) => c.name), (result.rows ?? []) as unknown[][]));
    return 0;
  } catch (err) {
    const message = (err as Error).message;
    console.error(message); // the database's own words, nothing added
    return /DPI-1067|call timeout/i.test(message) ? EXIT_UNAVAILABLE : EXIT_SQL;
  } finally {
    await connection.close().catch(() => {});
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
    process.exitCode = EXIT_UNAVAILABLE;
  },
);
