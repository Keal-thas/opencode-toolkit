#!/usr/bin/env node
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const LOKI_BASE_URL = process.env.LOKI_BASE_URL;
const LOKI_USERNAME = process.env.LOKI_USERNAME;
const LOKI_PASSWORD = process.env.LOKI_PASSWORD;
const LOKI_ORG_ID = process.env.LOKI_ORG_ID;
const LOKI_MCP_PORT = Number(process.env.LOKI_MCP_PORT ?? "8091");
// Only matters for the "naive" datetime case in resolveTimeParam() below -
// Loki itself is never told about this, it only ever sees a fully-
// qualified offset or an epoch. Defaults to Beijing time since that's
// this deployment's actual timezone; override for a different one.
const LOKI_DEFAULT_TZ_OFFSET = process.env.LOKI_DEFAULT_TZ_OFFSET ?? "+08:00";

if (!LOKI_BASE_URL) {
  console.error("Missing Loki connection details. Set LOKI_BASE_URL.");
  process.exit(1);
}

// Computing a correct start/end by hand (an exact RFC3339 offset, or -
// worse - a 19-digit nanosecond epoch) is real friction for whatever's
// calling this tool, model or human. This resolves three friendlier
// forms into whatever Loki actually accepts, so most callers never have
// to touch epoch math at all:
//   - "now" / "now-<duration>" (duration is <n><unit> pairs, unit one of
//     s/m/h/d, e.g. "now-1h", "now-30m", "now-1d") - the same relative-time
//     convention Grafana itself uses for Loki/Prometheus time ranges, not
//     an invented one.
//   - a bare "YYYY-MM-DDTHH:MM:SS" or "YYYY-MM-DD HH:MM:SS" with no
//     timezone - assumed to be in LOKI_DEFAULT_TZ_OFFSET and qualified
//     before being sent.
// Anything else (already a full RFC3339 offset, or a bare epoch number)
// passes straight through unchanged - both were already correct inputs
// before this existed, and stay correct. An unrecognized shape also
// passes straight through rather than being rejected here - Loki's own
// parser is the final judge and returns its own clean error, same
// full-passthrough philosophy as everywhere else in this server.
const RELATIVE_TIME_RE = /^now(?:-((?:\d+[smhd])+))?$/;
const DURATION_PART_RE = /(\d+)([smhd])/g;
const NAIVE_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function resolveTimeParam(value) {
  if (value === undefined || value === null) return value;

  const relative = RELATIVE_TIME_RE.exec(value);
  if (relative) {
    let offsetMs = 0;
    for (const [, amount, unit] of relative[1]?.matchAll(DURATION_PART_RE) ?? []) {
      offsetMs += Number(amount) * UNIT_MS[unit];
    }
    return String((Date.now() - offsetMs) * 1_000_000);
  }

  const naive = NAIVE_DATETIME_RE.exec(value);
  if (naive) return `${naive[1]}T${naive[2]}${LOKI_DEFAULT_TZ_OFFSET}`;

  return value;
}

// Loki's query API (what every tool below hits) has no write side at all -
// unlike Oracle there's no executeQuery()-style connection lifecycle or
// auditQuery() gate to design around here. Every call is a plain,
// stateless GET; this helper just centralizes URL-building, the optional
// auth headers, and turning a non-2xx/network failure into a clean
// {success: false} instead of a thrown error - mirroring the shape
// executeQuery() returns in mcp-servers/oracle/server.js, for the same reason:
// tool results should never surface as a raw MCP protocol error.
async function lokiFetch(path, params) {
  const url = new URL(path, LOKI_BASE_URL);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers = {};
  if (LOKI_USERNAME || LOKI_PASSWORD) {
    headers.Authorization = `Basic ${Buffer.from(`${LOKI_USERNAME ?? ""}:${LOKI_PASSWORD ?? ""}`).toString("base64")}`;
  }
  if (LOKI_ORG_ID) headers["X-Scope-OrgID"] = LOKI_ORG_ID;

  try {
    const response = await fetch(url, { headers });
    // Read as text first, not response.json() directly - Loki's error
    // responses aren't guaranteed to be the same JSON shape as its
    // success responses (sometimes plain text), so parsing is only safe
    // once response.ok is known.
    const text = await response.text();

    if (!response.ok) {
      return { success: false, error: `Loki returned ${response.status}: ${text || response.statusText}` };
    }

    const body = text ? JSON.parse(text) : null;
    return { success: true, data: body?.data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function queryRange({ query, start, end, limit, direction, step }) {
  return lokiFetch("/loki/api/v1/query_range", {
    query,
    start: resolveTimeParam(start),
    end: resolveTimeParam(end),
    limit,
    direction,
    step,
  });
}

async function listLabels({ start, end }) {
  return lokiFetch("/loki/api/v1/labels", { start: resolveTimeParam(start), end: resolveTimeParam(end) });
}

async function listLabelValues({ label, start, end }) {
  return lokiFetch(`/loki/api/v1/label/${encodeURIComponent(label)}/values`, {
    start: resolveTimeParam(start),
    end: resolveTimeParam(end),
  });
}

const TIME_PARAM_DESCRIPTION =
  `Accepts, in order of preference: a relative time ("now", "now-1h", "now-30m", "now-1d", ` +
  `"now-1h30m" - Grafana's own relative-time syntax for Loki/Prometheus); a local datetime with ` +
  `no timezone, e.g. "2026-09-15T10:00:00" or "2026-09-15 10:00:00" (assumed to be ${LOKI_DEFAULT_TZ_OFFSET}); ` +
  `or an already-qualified absolute value (RFC3339 with an explicit offset, e.g. "2026-09-15T10:00:00+08:00", ` +
  `or a unix epoch in seconds or nanoseconds).`;

function createMcpServer() {
  const server = new Server({ name: "loki-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "loki_query_range",
        description:
          "Run a LogQL query against the configured Loki instance over a time range and return matching log lines. Full passthrough - any valid LogQL expression, no restriction.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "LogQL query, e.g. '{app=\"api\"} |= \"error\"'" },
            start: { type: "string", description: TIME_PARAM_DESCRIPTION + " Optional - Loki defaults to a recent window." },
            end: { type: "string", description: TIME_PARAM_DESCRIPTION + " Optional." },
            limit: { type: "number", description: "Max number of log lines to return. Optional - Loki defaults to 100." },
            direction: { type: "string", enum: ["forward", "backward"], description: "Optional - Loki defaults to backward (newest first)." },
            step: { type: "string", description: "Query resolution step for metric queries, e.g. '30s'. Optional." },
          },
          required: ["query"],
        },
      },
      {
        name: "loki_labels",
        description: "List the label names known to Loki, optionally restricted to a time range. Use this to discover what's queryable before writing a LogQL selector.",
        inputSchema: {
          type: "object",
          properties: {
            start: { type: "string", description: TIME_PARAM_DESCRIPTION + " Optional." },
            end: { type: "string", description: TIME_PARAM_DESCRIPTION + " Optional." },
          },
        },
      },
      {
        name: "loki_label_values",
        description: "List the values seen for one label name, optionally restricted to a time range. Use this after loki_labels to find a concrete value to filter on.",
        inputSchema: {
          type: "object",
          properties: {
            label: { type: "string", description: "The label name to list values for, e.g. 'app' or 'namespace'." },
            start: { type: "string", description: TIME_PARAM_DESCRIPTION + " Optional." },
            end: { type: "string", description: TIME_PARAM_DESCRIPTION + " Optional." },
          },
          required: ["label"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    let result;
    switch (name) {
      case "loki_query_range":
        if (!args?.query) return { content: [{ type: "text", text: "Missing required argument: query" }], isError: true };
        result = await queryRange(args);
        break;
      case "loki_labels":
        result = await listLabels(args ?? {});
        break;
      case "loki_label_values":
        if (!args?.label) return { content: [{ type: "text", text: "Missing required argument: label" }], isError: true };
        result = await listLabelValues(args);
        break;
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  return server;
}

// Stateless mode (sessionIdGenerator: undefined) with a fresh Server +
// transport pair per request - same shell as mcp-servers/oracle/server.js, for the
// same reason (the SDK's own reference stateless Streamable HTTP server;
// no session state worth sharing between calls, and sharing one pair would
// just mean concurrent requests fighting over the same transport).
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

httpServer.listen(LOKI_MCP_PORT, () => {
  console.error(`Loki MCP server listening on http://localhost:${LOKI_MCP_PORT}/mcp`);
});
