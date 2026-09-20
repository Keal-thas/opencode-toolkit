#!/usr/bin/env node
import http from "node:http";
import oracledb from "oracledb";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ORACLE_CONNECT_STRING = process.env.ORACLE_CONNECT_STRING;
const ORACLE_USER = process.env.ORACLE_USER;
const ORACLE_PASSWORD = process.env.ORACLE_PASSWORD;
const ORACLE_MCP_PORT = Number(process.env.ORACLE_MCP_PORT ?? "8090");

if (!ORACLE_CONNECT_STRING || !ORACLE_USER || !ORACLE_PASSWORD) {
  console.error("Missing Oracle connection details. Set ORACLE_CONNECT_STRING, ORACLE_USER, ORACLE_PASSWORD.");
  process.exit(1);
}

// Extension point for the audit layer this tool intentionally ships without:
// a rule-based (regex/keyword denylist) or LLM-based check (mirroring
// plugins/llm-review-gate.ts's tool.execute.before gate) can plug in here
// later without touching executeQuery(). Until then this is a no-op that
// allows everything - oracle_query is a full passthrough by design, not an
// oversight. See mcp-servers/oracle/README.md for why.
async function auditQuery(sql) {
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
async function executeQuery(sql) {
  const verdict = await auditQuery(sql);
  if (!verdict.allow) {
    return { success: false, error: `Blocked by audit hook: ${verdict.reason ?? "no reason given"}` };
  }

  let connection;
  try {
    connection = await oracledb.getConnection({
      connectString: ORACLE_CONNECT_STRING,
      user: ORACLE_USER,
      password: ORACLE_PASSWORD,
    });

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
    return { success: false, error: err.message };
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

function createMcpServer() {
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

    const result = await executeQuery(args.sql);
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
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
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

httpServer.listen(ORACLE_MCP_PORT, () => {
  console.error(`Oracle MCP server listening on http://localhost:${ORACLE_MCP_PORT}/mcp`);
});
