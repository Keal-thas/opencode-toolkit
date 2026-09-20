#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { LspClient, LspClientError } from "./lsp-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = process.env.JAVA_LSP_WORKSPACE_ROOT;
const JDTLS_COMMAND_OVERRIDE = process.env.JDTLS_COMMAND;
const JDTLS_DATA_DIR = process.env.JDTLS_DATA_DIR;
const JAVA_EXECUTABLE = process.env.JAVA_EXECUTABLE; // see README - decoupled from whatever launches jdtls itself
const JAVA_LSP_MCP_PORT = Number(process.env.JAVA_LSP_MCP_PORT ?? "8092");

if (!WORKSPACE_ROOT) {
  console.error("Missing JAVA_LSP_WORKSPACE_ROOT - the Java project root jdtls should analyze.");
  process.exit(1);
}
if (!JDTLS_DATA_DIR) {
  console.error(
    "Missing JDTLS_DATA_DIR - jdtls's own workspace/index storage directory (its `-data` flag, unrelated " +
      "to WORKSPACE_ROOT). Use a directory dedicated to this one project; jdtls refuses to share a data " +
      "directory across concurrently-running instances for different projects.",
  );
  process.exit(1);
}

const LINE_CHAR_DESCRIPTION =
  "0-indexed, per the LSP spec (not the 1-indexed line numbers most editors display) - line 0 is the file's first line, character 0 is the first column.";

// vendor/jdt-language-server-<version>.tar.gz is committed (see README's
// Vendoring section) - extracted lazily on first startup into a sibling
// directory, not at npm-install time, mirroring mcp-servers/spring-lsp/server.js's
// resolveLanguageServerDir() (same reasoning: a `git pull` that bumps the
// vendored tarball is picked up automatically, no separate build step).
// JDTLS_COMMAND still overrides this entirely, e.g. to point at a
// system-installed jdtls (`brew install jdtls`) instead.
function resolveJdtlsCommand() {
  if (JDTLS_COMMAND_OVERRIDE) return JDTLS_COMMAND_OVERRIDE;
  const vendorDir = path.join(here, "vendor");
  const tarball = readdirSync(vendorDir).find((f) => f.endsWith(".tar.gz"));
  if (!tarball) {
    throw new Error(`No jdt-language-server-*.tar.gz found in ${vendorDir}, and JDTLS_COMMAND is not set.`);
  }
  const version = tarball.replace(/\.tar\.gz$/, "");
  const extractedDir = path.join(vendorDir, version);
  const launcher = path.join(extractedDir, "bin", "jdtls");
  if (!existsSync(launcher)) {
    console.error(`Extracting ${tarball} into ${extractedDir} (first run only)...`);
    execFileSync("mkdir", ["-p", extractedDir]);
    execFileSync("tar", ["-xzf", path.join(vendorDir, tarball), "-C", extractedDir]);
  }
  // bin/jdtls is Eclipse's own python3 launcher script (see README's
  // Vendoring section) - it needs python3 on PATH, same as it would via
  // `brew install jdtls`.
  return launcher;
}

// One jdtls process per server lifetime, not per request or per tool call -
// unlike mcp-servers/oracle's/mcp-servers/loki's per-request model, LSP is a genuinely
// stateful session (project indexing alone easily takes seconds; redoing
// initialize on every tool call would make this unusably slow, and jdtls
// doesn't support concurrent instances against the same -data dir anyway).
// Started lazily on first tool call, not at process startup, so the HTTP
// server itself comes up immediately - jdtls's own indexing then continues
// in the background after that first call returns.
let clientPromise;
function getClient(log) {
  if (!clientPromise) {
    const client = new LspClient({
      command: resolveJdtlsCommand(),
      args: [
        "-data",
        JDTLS_DATA_DIR,
        ...(JAVA_EXECUTABLE ? ["--java-executable", JAVA_EXECUTABLE] : []),
      ],
      rootPath: WORKSPACE_ROOT,
      log,
    });
    clientPromise = client.start().then(
      () => client,
      (err) => {
        clientPromise = undefined; // allow retry on the next call instead of caching a permanent failure
        throw err;
      },
    );
  }
  return clientPromise;
}

function resolveFile(file) {
  const abs = path.resolve(WORKSPACE_ROOT, file);
  if (!abs.startsWith(path.resolve(WORKSPACE_ROOT) + path.sep) && abs !== path.resolve(WORKSPACE_ROOT)) {
    throw new Error(`Refusing to open a path outside the configured workspace root: ${file}`);
  }
  return abs;
}

async function withOpenFile(log, file, fn) {
  const client = await getClient(log);
  const abs = resolveFile(file);
  const uri = await client.syncFile(abs, "java");
  return fn(client, uri);
}

async function toolResult(fn) {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err instanceof LspClientError ? err.message : String(err?.message ?? err) };
  }
}

function createMcpServer() {
  const server = new Server({ name: "java-lsp-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  const log = (kind, message) => console.error(`[jdtls:${kind}]`, message.toString().slice(0, 500));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "java_definition",
        description:
          "Jump to the definition of the Java symbol at a position, using jdtls's real type resolution (not text search) - handles overloads, inheritance, and cross-file references correctly.",
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string", description: `Path to a .java file, absolute or relative to ${WORKSPACE_ROOT}.` },
            line: { type: "number", description: LINE_CHAR_DESCRIPTION },
            character: { type: "number", description: LINE_CHAR_DESCRIPTION },
          },
          required: ["file", "line", "character"],
        },
      },
      {
        name: "java_references",
        description: "Find every real usage of the Java symbol at a position across the workspace (scope-aware, not a name-text grep).",
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string", description: `Path to a .java file, absolute or relative to ${WORKSPACE_ROOT}.` },
            line: { type: "number", description: LINE_CHAR_DESCRIPTION },
            character: { type: "number", description: LINE_CHAR_DESCRIPTION },
            includeDeclaration: { type: "boolean", description: "Include the declaration itself in the results. Defaults to true." },
          },
          required: ["file", "line", "character"],
        },
      },
      {
        name: "java_hover",
        description: "Get the resolved type signature and Javadoc for the Java symbol at a position.",
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string", description: `Path to a .java file, absolute or relative to ${WORKSPACE_ROOT}.` },
            line: { type: "number", description: LINE_CHAR_DESCRIPTION },
            character: { type: "number", description: LINE_CHAR_DESCRIPTION },
          },
          required: ["file", "line", "character"],
        },
      },
      {
        name: "java_implementation",
        description: "Jump from an interface or abstract method to its concrete implementation(s).",
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string", description: `Path to a .java file, absolute or relative to ${WORKSPACE_ROOT}.` },
            line: { type: "number", description: LINE_CHAR_DESCRIPTION },
            character: { type: "number", description: LINE_CHAR_DESCRIPTION },
          },
          required: ["file", "line", "character"],
        },
      },
      {
        name: "java_document_symbols",
        description: "List every class/method/field jdtls actually parsed out of one Java file, with kind and precise location - structural, not a text search.",
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string", description: `Path to a .java file, absolute or relative to ${WORKSPACE_ROOT}.` },
          },
          required: ["file"],
        },
      },
      {
        name: "java_workspace_symbols",
        description: "Fuzzy-search real declared symbols (classes/methods/fields) by name across the whole workspace jdtls has indexed - matches against jdtls's own symbol index, not file contents, so it won't match a name that only appears in a comment or string literal.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Symbol name or fragment to search for." },
          },
          required: ["query"],
        },
      },
      {
        name: "java_diagnostics",
        description: "Get jdtls's current compile errors/warnings for one Java file (opens/syncs the file first, then returns whatever diagnostics jdtls has published for it).",
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string", description: `Path to a .java file, absolute or relative to ${WORKSPACE_ROOT}.` },
            waitMs: { type: "number", description: "How long to wait for jdtls to publish diagnostics after opening the file, in ms. Defaults to 3000." },
          },
          required: ["file"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const position = () => ({ line: args.line, character: args.character });

    let result;
    switch (name) {
      case "java_definition":
        result = await toolResult(() =>
          withOpenFile(log, args.file, (client, uri) =>
            client.request("textDocument/definition", { textDocument: { uri }, position: position() }),
          ),
        );
        break;
      case "java_references":
        result = await toolResult(() =>
          withOpenFile(log, args.file, (client, uri) =>
            client.request("textDocument/references", {
              textDocument: { uri },
              position: position(),
              context: { includeDeclaration: args.includeDeclaration ?? true },
            }),
          ),
        );
        break;
      case "java_hover":
        result = await toolResult(() =>
          withOpenFile(log, args.file, (client, uri) =>
            client.request("textDocument/hover", { textDocument: { uri }, position: position() }),
          ),
        );
        break;
      case "java_implementation":
        result = await toolResult(() =>
          withOpenFile(log, args.file, (client, uri) =>
            client.request("textDocument/implementation", { textDocument: { uri }, position: position() }),
          ),
        );
        break;
      case "java_document_symbols":
        result = await toolResult(() =>
          withOpenFile(log, args.file, (client, uri) => client.request("textDocument/documentSymbol", { textDocument: { uri } })),
        );
        break;
      case "java_workspace_symbols":
        result = await toolResult(async () => {
          const client = await getClient(log);
          return client.request("workspace/symbol", { query: args.query });
        });
        break;
      case "java_diagnostics":
        result = await toolResult(() =>
          withOpenFile(log, args.file, async (client, uri) => {
            await new Promise((r) => setTimeout(r, args.waitMs ?? 3000));
            return client.getDiagnostics(uri);
          }),
        );
        break;
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  return server;
}

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

  // Stateless at the MCP/HTTP layer only (fresh Server+transport per
  // request, same as mcp-servers/oracle and mcp-servers/loki) - the jdtls process itself is
  // the one genuinely stateful thing here, and it's a module-level
  // singleton via getClient(), independent of this per-request pair.
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

httpServer.listen(JAVA_LSP_MCP_PORT, () => {
  console.error(`Java LSP MCP server listening on http://localhost:${JAVA_LSP_MCP_PORT}/mcp`);
});

process.on("SIGTERM", async () => {
  if (clientPromise) await clientPromise.then((c) => c.shutdown(), () => {});
  process.exit(0);
});
