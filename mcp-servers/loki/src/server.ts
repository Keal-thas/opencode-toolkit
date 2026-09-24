#!/usr/bin/env node
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { LokiConfig, ServerConfig } from "./types/config.js";

const DEFAULT_PORT = 8091; // the next free port after mcp-servers/oracle's 8090
const CONFIG_DIR = join(homedir(), ".config", "kealthas-dev", "opencode-mcp-loki");
const SERVER_CONFIG_PATH = join(CONFIG_DIR, "server.json");

const SAMPLE_SERVER_CONFIG = { LOKI_MCP_PORT: DEFAULT_PORT };
const SAMPLE_LOKI_CONFIG = {
  LOKI_BASE_URL: "http://192.168.1.100:3100 (no trailing path)",
  LOKI_USERNAME: "username (optional, HTTP basic auth)",
  LOKI_PASSWORD: "password (optional)",
  LOKI_ORG_ID: "tenant-id (optional, multi-tenant Loki / Grafana Cloud-style setups)",
  LOKI_DEFAULT_TZ_OFFSET: "+08:00 (optional, defaults to +08:00)",
  LOKI_VIA_GRAFANA: "true (optional - set when Loki is only reachable through Grafana's own datasource proxy, not directly; LOKI_BASE_URL becomes Grafana's URL in that case)",
  LOKI_GRAFANA_DATASOURCE_ID: "1 (optional, only used when LOKI_VIA_GRAFANA is true - defaults to 1)",
};

function printSampleConfig(label: string, path: string, sample: unknown): void {
  console.error(`\nExpected ${label} at: ${path}\n`);
  console.error(JSON.stringify(sample, null, 2));
  console.error("");
}

// LOKI_MCP_PORT env var overrides server.json, for running several
// instances (different projects/ports) without separate port files.
function loadServerConfig(): ServerConfig {
  if (process.env.LOKI_MCP_PORT !== undefined) {
    const port = Number(process.env.LOKI_MCP_PORT);
    if (!Number.isInteger(port) || port <= 0) {
      console.error(`LOKI_MCP_PORT must be a positive integer, got: ${JSON.stringify(process.env.LOKI_MCP_PORT)}`);
      process.exit(1);
    }
    return { LOKI_MCP_PORT: port };
  }

  if (!existsSync(SERVER_CONFIG_PATH)) {
    return { LOKI_MCP_PORT: DEFAULT_PORT };
  }

  try {
    const raw = JSON.parse(readFileSync(SERVER_CONFIG_PATH, "utf8"));
    const port = Number(raw.LOKI_MCP_PORT ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`LOKI_MCP_PORT must be a positive integer, got: ${JSON.stringify(raw.LOKI_MCP_PORT)}`);
    }
    return { LOKI_MCP_PORT: port };
  } catch (err) {
    console.error(`Failed to load server config: ${(err as Error).message}`);
    printSampleConfig("server config", SERVER_CONFIG_PATH, SAMPLE_SERVER_CONFIG);
    process.exit(1);
  }
}

// config.json by default, config-<name>.json when LOKI_CONFIG_ENV is set.
// Only LOKI_BASE_URL is required - Loki is commonly reachable unauthenticated
// on an internal LAN, unlike mcp-servers/oracle.
function loadLokiConfig(): LokiConfig {
  const envName = process.env.LOKI_CONFIG_ENV;
  const resolvedPath = join(CONFIG_DIR, envName ? `config-${envName}.json` : "config.json");
  if (!existsSync(resolvedPath)) {
    console.error(`Loki config file not found: ${resolvedPath}`);
    printSampleConfig("Loki config file", resolvedPath, SAMPLE_LOKI_CONFIG);
    process.exit(1);
  }

  try {
    const raw = JSON.parse(readFileSync(resolvedPath, "utf8"));
    if (!raw.LOKI_BASE_URL) {
      throw new Error("missing required key LOKI_BASE_URL");
    }
    return {
      LOKI_BASE_URL: raw.LOKI_BASE_URL,
      LOKI_USERNAME: raw.LOKI_USERNAME,
      LOKI_PASSWORD: raw.LOKI_PASSWORD,
      LOKI_ORG_ID: raw.LOKI_ORG_ID,
      LOKI_DEFAULT_TZ_OFFSET: raw.LOKI_DEFAULT_TZ_OFFSET,
      LOKI_VIA_GRAFANA: raw.LOKI_VIA_GRAFANA === true,
      LOKI_GRAFANA_DATASOURCE_ID: raw.LOKI_GRAFANA_DATASOURCE_ID !== undefined ? String(raw.LOKI_GRAFANA_DATASOURCE_ID) : "1",
    };
  } catch (err) {
    console.error(`Failed to load Loki config from ${resolvedPath}: ${(err as Error).message}`);
    printSampleConfig("Loki config file", resolvedPath, SAMPLE_LOKI_CONFIG);
    process.exit(1);
  }
}

const serverConfig = loadServerConfig();

// Hand-computing a correct start/end (an RFC3339 offset, or a 19-digit
// nanosecond epoch) is real friction, so this resolves two friendlier forms
// into what Loki accepts:
//   - "now"/"now-<duration>" (s/m/h/d units, e.g. "now-1h") - Grafana's own
//     relative-time convention, not an invented one.
//   - a bare "YYYY-MM-DDTHH:MM:SS"/"YYYY-MM-DD HH:MM:SS" with no timezone -
//     assumed to be LOKI_DEFAULT_TZ_OFFSET and qualified before sending.
// Anything else (already RFC3339, a bare epoch, or unrecognized) passes
// straight through - Loki's own parser is the final judge, same
// full-passthrough philosophy as everywhere else in this server.
const RELATIVE_TIME_RE = /^now(?:-((?:\d+[smhd])+))?$/;
const DURATION_PART_RE = /(\d+)([smhd])/g;
const NAIVE_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function resolveTimeParam(value: string | undefined, tzOffset: string): string | undefined {
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
  if (naive) return `${naive[1]}T${naive[2]}${tzOffset}`;

  return value;
}

type LokiResult = { success: true; data: unknown } | { success: false; error: string };

// Loki's API is read-only, so unlike Oracle there's no connection lifecycle
// or audit gate here - just a stateless GET. Centralizes URL-building, auth
// headers, and turning a non-2xx/network failure into {success: false}
// rather than a thrown error, so tool results never surface as a raw MCP error.
async function lokiFetch(path: string, params?: Record<string, unknown>): Promise<LokiResult> {
  const lokiConfig = loadLokiConfig();
  const effectivePath = lokiConfig.LOKI_VIA_GRAFANA
    ? `/api/datasources/proxy/${lokiConfig.LOKI_GRAFANA_DATASOURCE_ID}${path}`
    : path;
  const url = new URL(effectivePath, lokiConfig.LOKI_BASE_URL);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {};
  if (lokiConfig.LOKI_USERNAME || lokiConfig.LOKI_PASSWORD) {
    headers.Authorization = `Basic ${Buffer.from(`${lokiConfig.LOKI_USERNAME ?? ""}:${lokiConfig.LOKI_PASSWORD ?? ""}`).toString("base64")}`;
  }
  if (lokiConfig.LOKI_ORG_ID) headers["X-Scope-OrgID"] = lokiConfig.LOKI_ORG_ID;

  try {
    // Manual redirect handling: a Grafana instance rejecting the request
    // (missing/expired auth, or LOKI_VIA_GRAFANA off when it should be on)
    // responds with a 302 to its own login page, not a 401. Node's fetch
    // follows that by default, landing on the login page's HTML with a
    // misleadingly "successful" 200 status - the JSON.parse below would
    // then fail with an opaque syntax error instead of a diagnosable one.
    const response = await fetch(url, { headers, redirect: "manual" });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "(no Location header)";
      const hint = lokiConfig.LOKI_VIA_GRAFANA
        ? "check LOKI_USERNAME/LOKI_PASSWORD (must be a real Grafana user's Basic Auth) and LOKI_GRAFANA_DATASOURCE_ID"
        : "if this Loki is only reachable through Grafana's datasource proxy, set LOKI_VIA_GRAFANA: true (see README's Configuration section)";
      return { success: false, error: `Request was redirected (${response.status}) to ${location} instead of returning data - ${hint}.` };
    }

    // Text first, not response.json() - Loki's error responses aren't
    // guaranteed the same JSON shape as success (sometimes plain text).
    const text = await response.text();

    if (!response.ok) {
      return { success: false, error: `Loki returned ${response.status}: ${text || response.statusText}` };
    }

    const body = text ? JSON.parse(text) : null;
    return { success: true, data: body?.data };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

interface QueryRangeArgs {
  query: string;
  start?: string;
  end?: string;
  limit?: number;
  direction?: string;
  step?: string;
}

async function queryRange({ query, start, end, limit, direction, step }: QueryRangeArgs): Promise<LokiResult> {
  const tzOffset = loadLokiConfig().LOKI_DEFAULT_TZ_OFFSET ?? "+08:00";
  return lokiFetch("/loki/api/v1/query_range", {
    query,
    start: resolveTimeParam(start, tzOffset),
    end: resolveTimeParam(end, tzOffset),
    limit,
    direction,
    step,
  });
}

async function listLabels({ start, end }: { start?: string; end?: string }): Promise<LokiResult> {
  const tzOffset = loadLokiConfig().LOKI_DEFAULT_TZ_OFFSET ?? "+08:00";
  return lokiFetch("/loki/api/v1/labels", { start: resolveTimeParam(start, tzOffset), end: resolveTimeParam(end, tzOffset) });
}

async function listLabelValues({ label, start, end }: { label: string; start?: string; end?: string }): Promise<LokiResult> {
  const tzOffset = loadLokiConfig().LOKI_DEFAULT_TZ_OFFSET ?? "+08:00";
  return lokiFetch(`/loki/api/v1/label/${encodeURIComponent(label)}/values`, {
    start: resolveTimeParam(start, tzOffset),
    end: resolveTimeParam(end, tzOffset),
  });
}

function createMcpServer(): Server {
  const tzOffset = loadLokiConfig().LOKI_DEFAULT_TZ_OFFSET ?? "+08:00";
  const TIME_PARAM_DESCRIPTION =
    `Accepts, in order of preference: a relative time ("now", "now-1h", "now-30m", "now-1d", ` +
    `"now-1h30m" - Grafana's own relative-time syntax for Loki/Prometheus); a local datetime with ` +
    `no timezone, e.g. "2026-09-15T10:00:00" or "2026-09-15 10:00:00" (assumed to be ${tzOffset}); ` +
    `or an already-qualified absolute value (RFC3339 with an explicit offset, e.g. "2026-09-15T10:00:00+08:00", ` +
    `or a unix epoch in seconds or nanoseconds).`;
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

    let result: LokiResult;
    switch (name) {
      case "loki_query_range":
        if (!args?.query) return { content: [{ type: "text", text: "Missing required argument: query" }], isError: true };
        result = await queryRange(args as unknown as QueryRangeArgs);
        break;
      case "loki_labels":
        result = await listLabels((args ?? {}) as { start?: string; end?: string });
        break;
      case "loki_label_values":
        if (!args?.label) return { content: [{ type: "text", text: "Missing required argument: label" }], isError: true };
        result = await listLabelValues(args as unknown as { label: string; start?: string; end?: string });
        break;
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  return server;
}

// Stateless mode: fresh Server+transport pair per request, same shape and
// reason as oracle/src/server.ts - no session state to share, and reusing
// one pair would mean requests fighting over it.
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

httpServer.listen(serverConfig.LOKI_MCP_PORT, () => {
  console.error(`Loki MCP server listening on http://localhost:${serverConfig.LOKI_MCP_PORT}/mcp`);
});
