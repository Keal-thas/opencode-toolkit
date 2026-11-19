#!/usr/bin/env node
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import oracledb from "oracledb";
import { CONFIG_DIR, SERVER_CONFIG_PATH, DEFAULT_PORT, loadServerConfig } from "./paths.js";
import type { DatabaseConfig, QueryResult } from "./types/config.js";

const DEFAULT_MAX_ROWS = 10_000;
const MAX_BODY_BYTES = 1_000_000;

const SAMPLE_SERVER_CONFIG = { ORACLE_MCP_PORT: DEFAULT_PORT };
const SAMPLE_DATABASE_CONFIG = {
  ORACLE_CONNECT_STRING: "hostname:1521/service_name (Easy Connect or TNS, either works)",
  ORACLE_USER: "username",
  ORACLE_PASSWORD: "password",
  ORACLE_DEFAULT_SCHEMA: "SCHEMA_NAME (optional; exact case as Oracle stores it - normally UPPERCASE, e.g. HR not hr)",
  ORACLE_MAX_ROWS: "10000 (optional; the most rows one query may return)",
};

// Read per query, so editing the file needs no restart. A bad file must fail
// that one query, not the process: it throws, and runQuery() reports it.
function loadDatabaseConfig(): DatabaseConfig {
  const envName = process.env.ORACLE_CONFIG_ENV;
  const resolvedPath = join(CONFIG_DIR, envName ? `config-${envName}.json` : "config.json");
  const sample = `Expected database config file at: ${resolvedPath}\n${JSON.stringify(SAMPLE_DATABASE_CONFIG, null, 2)}`;
  if (!existsSync(resolvedPath)) {
    throw new Error(`Database config file not found.\n${sample}`);
  }
  try {
    const raw = JSON.parse(readFileSync(resolvedPath, "utf8"));
    const { ORACLE_CONNECT_STRING, ORACLE_USER, ORACLE_PASSWORD, ORACLE_DEFAULT_SCHEMA } = raw;
    if (!ORACLE_CONNECT_STRING || !ORACLE_USER || !ORACLE_PASSWORD) {
      throw new Error("missing one of ORACLE_CONNECT_STRING, ORACLE_USER, ORACLE_PASSWORD");
    }
    const maxRows = raw.ORACLE_MAX_ROWS === undefined ? undefined : Number(raw.ORACLE_MAX_ROWS);
    if (maxRows !== undefined && (!Number.isInteger(maxRows) || maxRows <= 0)) {
      throw new Error(`ORACLE_MAX_ROWS must be a positive integer, got: ${JSON.stringify(raw.ORACLE_MAX_ROWS)}`);
    }
    return { ORACLE_CONNECT_STRING, ORACLE_USER, ORACLE_PASSWORD, ORACLE_DEFAULT_SCHEMA, ORACLE_MAX_ROWS: maxRows };
  } catch (err) {
    throw new Error(`Failed to load database config from ${resolvedPath}: ${(err as Error).message}\n${sample}`);
  }
}

// Extension point for an audit layer this server ships without: a rule-based
// or LLM-based check (mirroring llm-review-gate.ts's gate) could plug in here.
// No-op for now. See README.
async function auditQuery(_sql: string): Promise<{ allow: boolean; reason?: string }> {
  return { allow: true };
}

// oracledb has no timeout of any kind by default (getConnection() can hang
// forever against a host that accepts the TCP connection but never
// responds, and execute() the same against a connection that goes dark
// mid-session, e.g. blocked on a lock) - both units are oracledb's own,
// not a shared convention: connectTimeout is seconds, callTimeout is ms.
const CONNECT_TIMEOUT_SECONDS = 10;
const CALL_TIMEOUT_MS = 30_000;

// Everything comes back as plain text or numbers, never as a driver object:
// - CLOB/NCLOB as strings and BLOB as base64 (Lob objects hold the connection and can't be serialized)
// - RAW as hex (a Buffer would serialize as {"type":"Buffer",...})
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

// One connection per request, not pooled - deliberate:
// - nothing can outlive the request (closing rolls back anything open)
// - concurrent calls never race on the same session
// - a session dropped DB-side only fails that one request, not every one after
// Tradeoff: connection-setup latency per call - fine for low-QPS internal use.
//
// Every query runs inside SET TRANSACTION READ ONLY, so DML is refused by
// Oracle itself (ORA-01456) even for an account that holds write grants.
// DDL is not covered by that (it commits first), so the connecting account's
// own grants stay the real boundary - see README.
async function runQuery(sql: string, schema: string | undefined, limit: number | undefined): Promise<QueryResult> {
  const verdict = await auditQuery(sql);
  if (!verdict.allow) {
    return { success: false, kind: "blocked", error: `Blocked by audit hook: ${verdict.reason ?? "no reason given"}` };
  }

  let dbConfig: DatabaseConfig;
  try {
    dbConfig = loadDatabaseConfig();
  } catch (err) {
    return { success: false, kind: "config", error: (err as Error).message };
  }
  const cap = dbConfig.ORACLE_MAX_ROWS ?? DEFAULT_MAX_ROWS;
  const effectiveLimit = Math.min(limit ?? cap, cap);
  const effectiveSchema = schema ?? dbConfig.ORACLE_DEFAULT_SCHEMA;

  let connection: oracledb.Connection | undefined;
  try {
    try {
      connection = await oracledb.getConnection({
        connectString: dbConfig.ORACLE_CONNECT_STRING,
        user: dbConfig.ORACLE_USER,
        password: dbConfig.ORACLE_PASSWORD,
        connectTimeout: CONNECT_TIMEOUT_SECONDS,
      });
    } catch (err) {
      return { success: false, kind: "connection", error: (err as Error).message };
    }
    connection.callTimeout = CALL_TIMEOUT_MS;

    // ALTER SESSION commits implicitly, and SET TRANSACTION must be the first
    // statement of a transaction, so all session setup comes first.
    // No bind variables for identifiers in ALTER SESSION: the schema is
    // interpolated, which is fine for a caller that may run arbitrary SQL anyway.
    if (effectiveSchema) {
      await connection.execute(`ALTER SESSION SET CURRENT_SCHEMA = "${effectiveSchema}"`);
    }
    // So a date literal in the SQL ('2024-01-02 03:04:05') converts the way the output prints.
    await connection.execute(
      `ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS' NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF' NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZR'`,
    );
    await connection.execute("SET TRANSACTION READ ONLY");

    // Fetch one more row than asked for, to know whether there was more.
    const result = await connection.execute(stripTrailingSemicolon(sql), [], {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      maxRows: effectiveLimit + 1,
    });

    const columns = (result.metaData ?? []).map((col) => col.name);
    const rows = (result.rows ?? []) as unknown[][];
    const truncated = rows.length > effectiveLimit;
    return { success: true, columns, rows: truncated ? rows.slice(0, effectiveLimit) : rows, truncated };
  } catch (err) {
    const message = (err as Error).message;
    return { success: false, kind: /DPI-1067|call timeout/i.test(message) ? "timeout" : "sql", error: message };
  } finally {
    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        console.error("Error closing connection:", err);
      }
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/query") {
    res.writeHead(404).end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { success: false, error: "Method not allowed, use POST" });
    return;
  }

  let input: { sql?: unknown; schema?: unknown; limit?: unknown };
  try {
    input = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { success: false, error: `Request body must be JSON: ${(err as Error).message}` });
    return;
  }
  if (typeof input.sql !== "string" || input.sql.trim() === "") {
    sendJson(res, 400, { success: false, error: '"sql" must be a non-empty string' });
    return;
  }
  if (input.schema !== undefined && typeof input.schema !== "string") {
    sendJson(res, 400, { success: false, error: '"schema" must be a string' });
    return;
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || (input.limit as number) <= 0)) {
    sendJson(res, 400, { success: false, error: '"limit" must be a positive integer' });
    return;
  }

  sendJson(res, 200, await runQuery(input.sql, input.schema as string | undefined, input.limit as number | undefined));
});

httpServer.on("error", (err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});

let serverConfig;
try {
  serverConfig = loadServerConfig();
} catch (err) {
  console.error(`Failed to load server config: ${(err as Error).message}`);
  console.error(`\nExpected server config at: ${SERVER_CONFIG_PATH}\n\n${JSON.stringify(SAMPLE_SERVER_CONFIG, null, 2)}\n`);
  process.exit(1);
}

httpServer.listen(serverConfig.ORACLE_MCP_PORT, () => {
  console.error(`Oracle query server listening on http://localhost:${serverConfig.ORACLE_MCP_PORT}/query`);
});
