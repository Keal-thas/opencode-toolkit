#!/usr/bin/env node
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import oracledb from "oracledb";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DatabaseConfig, ServerConfig } from "./types/config.js";

const DEFAULT_PORT = 8090;
const CONFIG_DIR = join(homedir(), ".config", "kealthas-dev", "opencode-mcp-oracle");
const SERVER_CONFIG_PATH = join(CONFIG_DIR, "server.json");

const SAMPLE_SERVER_CONFIG = { ORACLE_MCP_PORT: DEFAULT_PORT };
const SAMPLE_DATABASE_CONFIG = {
  ORACLE_CONNECT_STRING: "hostname:1521/service_name (Easy Connect or TNS, either works)",
  ORACLE_USER: "username",
  ORACLE_PASSWORD: "password",
  ORACLE_DEFAULT_SCHEMA: "schema_name (optional)",
};

function printSampleConfig(label: string, path: string, sample: unknown): void {
  console.error(`\nExpected ${label} at: ${path}\n`);
  console.error(JSON.stringify(sample, null, 2));
  console.error("");
}

// ORACLE_MCP_PORT env var overrides server.json, for running several
// instances (different databases/ports) without separate port files.
function loadServerConfig(): ServerConfig {
  if (process.env.ORACLE_MCP_PORT !== undefined) {
    const port = Number(process.env.ORACLE_MCP_PORT);
    if (!Number.isInteger(port) || port <= 0) {
      console.error(`ORACLE_MCP_PORT must be a positive integer, got: ${JSON.stringify(process.env.ORACLE_MCP_PORT)}`);
      process.exit(1);
    }
    return { ORACLE_MCP_PORT: port };
  }

  if (!existsSync(SERVER_CONFIG_PATH)) {
    return { ORACLE_MCP_PORT: DEFAULT_PORT };
  }

  try {
    const raw = JSON.parse(readFileSync(SERVER_CONFIG_PATH, "utf8"));
    const port = Number(raw.ORACLE_MCP_PORT ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`ORACLE_MCP_PORT must be a positive integer, got: ${JSON.stringify(raw.ORACLE_MCP_PORT)}`);
    }
    return { ORACLE_MCP_PORT: port };
  } catch (err) {
    console.error(`Failed to load server config: ${(err as Error).message}`);
    printSampleConfig("server config", SERVER_CONFIG_PATH, SAMPLE_SERVER_CONFIG);
    process.exit(1);
  }
}

// config.json by default, config-<name>.json when ORACLE_CONFIG_ENV is set.
function loadDatabaseConfig(): DatabaseConfig {
  const envName = process.env.ORACLE_CONFIG_ENV;
  const resolvedPath = join(CONFIG_DIR, envName ? `config-${envName}.json` : "config.json");
  if (!existsSync(resolvedPath)) {
    console.error(`Database config file not found: ${resolvedPath}`);
    printSampleConfig("database config file", resolvedPath, SAMPLE_DATABASE_CONFIG);
    process.exit(1);
  }

  try {
    const raw = JSON.parse(readFileSync(resolvedPath, "utf8"));
    const { ORACLE_CONNECT_STRING, ORACLE_USER, ORACLE_PASSWORD, ORACLE_DEFAULT_SCHEMA } = raw;
    if (!ORACLE_CONNECT_STRING || !ORACLE_USER || !ORACLE_PASSWORD) {
      throw new Error("missing one of ORACLE_CONNECT_STRING, ORACLE_USER, ORACLE_PASSWORD");
    }
    return { ORACLE_CONNECT_STRING, ORACLE_USER, ORACLE_PASSWORD, ORACLE_DEFAULT_SCHEMA };
  } catch (err) {
    console.error(`Failed to load database config from ${resolvedPath}: ${(err as Error).message}`);
    printSampleConfig("database config file", resolvedPath, SAMPLE_DATABASE_CONFIG);
    process.exit(1);
  }
}

const serverConfig = loadServerConfig();

// Extension point for the audit layer this tool intentionally ships without:
// a rule-based (regex/keyword denylist) or LLM-based check (mirroring
// plugins/llm-review-gate.ts's tool.execute.before gate) can plug in here
// later without touching executeQuery(). Until then this is a no-op that
// allows everything - oracle_query is a full passthrough by design, not an
// oversight. See mcp-servers/oracle/README.md for why.
async function auditQuery(sql: string): Promise<{ allow: boolean; reason?: string }> {
  return { allow: true };
}

// One connection per request - opened and closed within a single call, not
// pooled or shared across requests. Deliberate, not the simple-but-wrong
// default:
// - a stray DML statement never outlives the request: closing an Oracle
//   session with uncommitted work implicitly rolls it back, so nothing can
//   hold row locks for the lifetime of this long-running server process
// - concurrent tool calls never race on the same session
// - a session killed or dropped on the DB side only fails the one request
//   in flight, never every request after it until the process is restarted
// Tradeoff: connection-setup latency on every call - fine for an
// interactive/low-QPS internal tool, not for anything latency-sensitive.
async function executeQuery(sql: string, schema?: string) {
  const verdict = await auditQuery(sql);
  if (!verdict.allow) {
    return { success: false, error: `Blocked by audit hook: ${verdict.reason ?? "no reason given"}` };
  }

  const dbConfig = loadDatabaseConfig();
  const effectiveSchema = schema ?? dbConfig.ORACLE_DEFAULT_SCHEMA;

  let connection: oracledb.Connection | undefined;
  try {
    connection = await oracledb.getConnection({
      connectString: dbConfig.ORACLE_CONNECT_STRING,
      user: dbConfig.ORACLE_USER,
      password: dbConfig.ORACLE_PASSWORD,
    });

    // No bind variables for identifiers in ALTER SESSION - same full-
    // passthrough stance as sql itself, safety lives elsewhere (read-only
    // DB account, see README).
    if (effectiveSchema) {
      await connection.execute(`ALTER SESSION SET CURRENT_SCHEMA = "${effectiveSchema}"`);
    }

    const result = await connection.execute(sql, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      // Passthrough includes DML. Without this, a successful UPDATE/INSERT
      // would report no error but silently roll back the moment the
      // connection closes right after - since every request gets its own
      // connection, that's immediately. Committing makes writes that are
      // sent actually take effect, matching "whatever request comes in,
      // just run it."
      autoCommit: true,
    });

    if (result.rows) {
      return {
        success: true,
        rows: result.rows,
        rowCount: result.rows.length,
        columns: (result.metaData ?? []).map((col) => col.name),
      };
    }

    // DDL/DML statements have no `rows` - report what changed instead.
    return {
      success: true,
      rowsAffected: result.rowsAffected ?? 0,
      message: "Statement executed, no result set",
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
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

function createMcpServer(): Server {
  const server = new Server({ name: "oracle-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "oracle_query",
        description:
          "Execute an ad-hoc SQL statement against the configured Oracle database. Full passthrough - no read-only restriction, no keyword filtering.",
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string", description: "The SQL statement to execute" },
            schema: {
              type: "string",
              description: "Optional - run against this schema (ALTER SESSION SET CURRENT_SCHEMA) instead of ORACLE_DEFAULT_SCHEMA/the connecting user's own schema.",
            },
          },
          required: ["sql"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name !== "oracle_query") {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    if (!args?.sql) {
      return { content: [{ type: "text", text: "Missing required argument: sql" }], isError: true };
    }

    const result = await executeQuery(args.sql as string, args.schema as string | undefined);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  return server;
}

// Stateless mode (sessionIdGenerator: undefined) with a fresh Server +
// transport pair per request, matching the SDK's own reference stateless
// Streamable HTTP server and mirroring executeQuery()'s one-connection-
// per-request Oracle design above - there's no session state to share
// between calls, so nothing is gained by keeping one pair alive across
// requests, and doing so would mean concurrent requests fighting over the
// same transport instance.
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

httpServer.listen(serverConfig.ORACLE_MCP_PORT, () => {
  console.error(`Oracle MCP server listening on http://localhost:${serverConfig.ORACLE_MCP_PORT}/mcp`);
});
