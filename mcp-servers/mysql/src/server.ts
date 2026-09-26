#!/usr/bin/env node
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { DatabaseConfig, ServerConfig } from "./types/config.js";

const DEFAULT_PORT = 8094;
const CONFIG_DIR = join(homedir(), ".config", "kealthas-dev", "opencode-mcp-mysql");
const SERVER_CONFIG_PATH = join(CONFIG_DIR, "server.json");

const SAMPLE_SERVER_CONFIG = { MYSQL_MCP_PORT: DEFAULT_PORT };
const SAMPLE_DATABASE_CONFIG = {
  MYSQL_CONNECT_STRING: "mysql://username:password@hostname:3306/database_name",
};

function printSampleConfig(label: string, path: string, sample: unknown): void {
  console.error(`\nExpected ${label} at: ${path}\n`);
  console.error(JSON.stringify(sample, null, 2));
  console.error("");
}

// MYSQL_MCP_PORT env var overrides server.json, for running several
// instances (different databases/ports) without separate port files.
function loadServerConfig(): ServerConfig {
  if (process.env.MYSQL_MCP_PORT !== undefined) {
    const port = Number(process.env.MYSQL_MCP_PORT);
    if (!Number.isInteger(port) || port <= 0) {
      console.error(`MYSQL_MCP_PORT must be a positive integer, got: ${JSON.stringify(process.env.MYSQL_MCP_PORT)}`);
      process.exit(1);
    }
    return { MYSQL_MCP_PORT: port };
  }

  if (!existsSync(SERVER_CONFIG_PATH)) {
    return { MYSQL_MCP_PORT: DEFAULT_PORT };
  }

  try {
    const raw = JSON.parse(readFileSync(SERVER_CONFIG_PATH, "utf8"));
    const port = Number(raw.MYSQL_MCP_PORT ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`MYSQL_MCP_PORT must be a positive integer, got: ${JSON.stringify(raw.MYSQL_MCP_PORT)}`);
    }
    return { MYSQL_MCP_PORT: port };
  } catch (err) {
    console.error(`Failed to load server config: ${(err as Error).message}`);
    printSampleConfig("server config", SERVER_CONFIG_PATH, SAMPLE_SERVER_CONFIG);
    process.exit(1);
  }
}

// config.json by default, config-<name>.json when MYSQL_CONFIG_ENV is set.
function loadDatabaseConfig(): DatabaseConfig {
  const envName = process.env.MYSQL_CONFIG_ENV;
  const resolvedPath = join(CONFIG_DIR, envName ? `config-${envName}.json` : "config.json");
  if (!existsSync(resolvedPath)) {
    console.error(`Database config file not found: ${resolvedPath}`);
    printSampleConfig("database config file", resolvedPath, SAMPLE_DATABASE_CONFIG);
    process.exit(1);
  }

  try {
    const raw = JSON.parse(readFileSync(resolvedPath, "utf8"));
    const { MYSQL_CONNECT_STRING } = raw;
    if (!MYSQL_CONNECT_STRING) {
      throw new Error("missing MYSQL_CONNECT_STRING");
    }
    return { MYSQL_CONNECT_STRING };
  } catch (err) {
    console.error(`Failed to load database config from ${resolvedPath}: ${(err as Error).message}`);
    printSampleConfig("database config file", resolvedPath, SAMPLE_DATABASE_CONFIG);
    process.exit(1);
  }
}

const serverConfig = loadServerConfig();

// Extension point for an audit layer this tool ships without: a rule-based
// or LLM-based check (mirroring llm-review-gate.ts's gate) could plug in here.
// No-op for now - full passthrough by design, not an oversight. See README.
async function auditQuery(sql: string): Promise<{ allow: boolean; reason?: string }> {
  return { allow: true };
}

// One connection per request, not pooled - deliberate, same reasoning as
// mcp-servers/oracle/src/server.ts:
// - a stray statement can't outlive the request (closing ends its transaction)
// - concurrent calls never race on the same session
// - a session dropped DB-side only fails that one request, not every one after
// Tradeoff: connection-setup latency per call - fine for low-QPS internal use.
async function executeQuery(sql: string, database?: string) {
  const verdict = await auditQuery(sql);
  if (!verdict.allow) {
    return { success: false, error: `Blocked by audit hook: ${verdict.reason ?? "no reason given"}` };
  }

  const dbConfig = loadDatabaseConfig();

  let connection: mysql.Connection | undefined;
  try {
    // mysql2 parses the URI natively - no hand-rolled host/port/user
    // splitting. The connect string's own database (if any) is the
    // default; the per-call `database` argument overrides it via USE below.
    connection = await mysql.createConnection(dbConfig.MYSQL_CONNECT_STRING);

    // No bind variables for identifiers in USE - same full-passthrough stance
    // as sql itself, safety lives elsewhere (read-only DB account, see README).
    if (database) {
      await connection.query(`USE \`${database}\``);
    }

    // The enforcement mechanism, not just a defense layer: unconditionally
    // blocks DML (INSERT/UPDATE/DELETE all fail with error 1792, confirmed
    // against a real MySQL 8 instance) regardless of the connecting account's
    // own grants. Does NOT block DDL (CREATE/DROP/ALTER implicitly commit
    // before running, which takes them outside this transaction entirely -
    // also confirmed against a real instance, not assumed) - closing that
    // residual gap needs the account's own grants too, see README.
    await connection.query("START TRANSACTION READ ONLY");

    try {
      const [result, fields] = await connection.query(sql);
      await connection.commit();

      if (Array.isArray(result)) {
        return {
          success: true,
          rows: result,
          rowCount: result.length,
          columns: (fields ?? []).map((col) => col.name),
        };
      }

      // DDL/DML statements return a ResultSetHeader, not an array of rows -
      // report what changed instead. Only reachable at all if the connecting
      // account's grants allow it, since the READ ONLY transaction above
      // doesn't block DDL (see comment above).
      return {
        success: true,
        rowsAffected: (result as mysql.ResultSetHeader).affectedRows ?? 0,
        message: "Statement executed, no result set",
      };
    } catch (err) {
      await connection.rollback().catch(() => {});
      throw err;
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch (err) {
        console.error("Error closing connection:", err);
      }
    }
  }
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "mysql-mcp", version: "1.0.0" });

  server.registerTool(
    "mysql_query",
    {
      description:
        "Execute an ad-hoc SQL statement against the configured MySQL database, unconditionally wrapped in a READ ONLY transaction - no keyword filtering, this is the enforcement mechanism. It always blocks DML (INSERT/UPDATE/DELETE), even for an account with full write privileges. It does NOT block DDL (CREATE/DROP/ALTER, which implicitly commit before running, escaping the transaction) - that residual gap is the connecting account's own grants' job, see README.",
      inputSchema: {
        sql: z.string().describe("The SQL statement to execute"),
        database: z
          .string()
          .optional()
          .describe("Optional - run against this database (USE database) instead of the connect string's own database."),
      },
    },
    async ({ sql, database }) => {
      const result = await executeQuery(sql, database);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  return server;
}

// Stateless mode: fresh Server+transport pair per request, matching the SDK's
// reference server and executeQuery()'s per-request design above - no session
// state to share, and reusing one pair would mean requests fighting over it.
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" }).end(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
    );
    return;
  }

  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    mcpServer.close();
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }),
      );
    }
  }
});

httpServer.on("error", (err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});

httpServer.listen(serverConfig.MYSQL_MCP_PORT, () => {
  console.error(`MySQL MCP server listening on http://localhost:${serverConfig.MYSQL_MCP_PORT}/mcp`);
});
