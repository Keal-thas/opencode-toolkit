#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { LspClient, LspClientError } from "./lsp-client.js";
import type { JavaLspConfig, ServerConfig } from "./types/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8092; // the next free port after mcp-servers/loki's 8091
const CONFIG_DIR = path.join(homedir(), ".config", "kealthas-dev", "opencode-mcp-java-lsp");
const SERVER_CONFIG_PATH = path.join(CONFIG_DIR, "server.json");

const SAMPLE_SERVER_CONFIG = { JAVA_LSP_MCP_PORT: DEFAULT_PORT };
const SAMPLE_JAVA_LSP_CONFIG = {
  JAVA_LSP_WORKSPACE_ROOT: "/path/to/your/java/project",
  JDTLS_DATA_DIR: "/path/to/a/scratch/dir/jdtls-data",
  JDTLS_COMMAND: "/path/to/some/other/jdtls (optional, defaults to the vendored jdtls)",
  JAVA_EXECUTABLE: "/path/to/jdk8/bin/java (optional, see README.md's JDK version section)",
};

function printSampleConfig(label: string, path_: string, sample: unknown): void {
  console.error(`\nExpected ${label} at: ${path_}\n`);
  console.error(JSON.stringify(sample, null, 2));
  console.error("");
}

// server.json is infrastructure config (which port to bind) that doesn't
// vary per environment, so it lives at one fixed path rather than being
// pointed at like the java-lsp config below. Missing entirely just means
// "use the default port" - only a present-but-broken file is treated as a
// real error, since its existence signals intent to override the default.
function loadServerConfig(): ServerConfig {
  if (!existsSync(SERVER_CONFIG_PATH)) {
    return { JAVA_LSP_MCP_PORT: DEFAULT_PORT };
  }

  try {
    const raw = JSON.parse(readFileSync(SERVER_CONFIG_PATH, "utf8"));
    const port = Number(raw.JAVA_LSP_MCP_PORT ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`JAVA_LSP_MCP_PORT must be a positive integer, got: ${JSON.stringify(raw.JAVA_LSP_MCP_PORT)}`);
    }
    return { JAVA_LSP_MCP_PORT: port };
  } catch (err) {
    console.error(`Failed to load server config: ${(err as Error).message}`);
    printSampleConfig("server config", SERVER_CONFIG_PATH, SAMPLE_SERVER_CONFIG);
    process.exit(1);
  }
}

// The Java project to analyze is per-environment/per-project, but the
// *location* it's read from is never user-supplied - only a short env name
// is (e.g. "my-project"), which selects a fixed file under
// CONFIG_DIR/configs/. This avoids the class of bug an arbitrary-path env
// var invites: a caller's shell not expanding "~", a quoted value
// suppressing that expansion, a typo'd relative path resolving against
// whatever cwd happens to be - all of which point path.resolve() somewhere
// unintended, silently. A bare name has none of that surface. No env var
// set falls back to config.json directly in CONFIG_DIR (not configs/) for
// the common single-project case.
const DEFAULT_JAVA_LSP_CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const JAVA_LSP_CONFIGS_DIR = path.join(CONFIG_DIR, "configs");
const CONFIG_ENV_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function loadJavaLspConfig(): JavaLspConfig {
  const envName = process.env.JAVA_LSP_CONFIG_ENV;
  if (envName !== undefined && !CONFIG_ENV_NAME_RE.test(envName)) {
    console.error(`JAVA_LSP_CONFIG_ENV must be a plain name (letters, digits, "-", "_"), got: ${JSON.stringify(envName)}`);
    process.exit(1);
  }
  const resolvedPath = envName ? path.join(JAVA_LSP_CONFIGS_DIR, `${envName}.json`) : DEFAULT_JAVA_LSP_CONFIG_PATH;
  if (!existsSync(resolvedPath)) {
    if (envName) {
      console.error(`java-lsp config file not found: ${resolvedPath}`);
      console.error(`(JAVA_LSP_CONFIG_ENV=${envName} looks for "${envName}.json" under ${JAVA_LSP_CONFIGS_DIR})`);
    } else {
      console.error(`No JAVA_LSP_CONFIG_ENV set and no default config file at: ${resolvedPath}`);
      console.error(`Either create that file, or set JAVA_LSP_CONFIG_ENV to the name of a file under ${JAVA_LSP_CONFIGS_DIR}/, e.g.:`);
      console.error("  JAVA_LSP_CONFIG_ENV=my-project opencode-mcp-java-lsp");
    }
    printSampleConfig("java-lsp config file", resolvedPath, SAMPLE_JAVA_LSP_CONFIG);
    process.exit(1);
  }

  try {
    const raw = JSON.parse(readFileSync(resolvedPath, "utf8"));
    const { JAVA_LSP_WORKSPACE_ROOT, JDTLS_DATA_DIR, JDTLS_COMMAND, JAVA_EXECUTABLE } = raw;
    if (!JAVA_LSP_WORKSPACE_ROOT) {
      throw new Error("missing required key JAVA_LSP_WORKSPACE_ROOT (the Java project root jdtls should analyze)");
    }
    if (!JDTLS_DATA_DIR) {
      throw new Error(
        "missing required key JDTLS_DATA_DIR (jdtls's own workspace/index storage directory, its -data flag, " +
          "not the project root - use a directory dedicated to this one project)",
      );
    }
    return { JAVA_LSP_WORKSPACE_ROOT, JDTLS_DATA_DIR, JDTLS_COMMAND, JAVA_EXECUTABLE };
  } catch (err) {
    console.error(`Failed to load java-lsp config from ${resolvedPath}: ${(err as Error).message}`);
    printSampleConfig("java-lsp config file", resolvedPath, SAMPLE_JAVA_LSP_CONFIG);
    process.exit(1);
  }
}

const serverConfig = loadServerConfig();
const javaLspConfig = loadJavaLspConfig();
const WORKSPACE_ROOT = javaLspConfig.JAVA_LSP_WORKSPACE_ROOT;

const LINE_CHAR_DESCRIPTION =
  "0-indexed, per the LSP spec (not the 1-indexed line numbers most editors display) - line 0 is the file's first line, character 0 is the first column.";

// vendor/jdt-language-server-<version>.tar.gz is committed (see README's
// Vendoring section) - extracted lazily on first startup into a sibling
// directory, not at npm-install time, mirroring mcp-servers/spring-lsp/src/server.ts's
// resolveLanguageServerDir() (same reasoning: a `git pull` that bumps the
// vendored tarball is picked up automatically, no separate build step).
// JDTLS_COMMAND still overrides this entirely, e.g. to point at a
// system-installed jdtls (`brew install jdtls`) instead.
function resolveJdtlsCommand(): string {
  if (javaLspConfig.JDTLS_COMMAND) return javaLspConfig.JDTLS_COMMAND;
  const vendorDir = path.join(here, "..", "vendor");
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
let clientPromise: Promise<LspClient> | undefined;
function getClient(log: (kind: string, message: string) => void): Promise<LspClient> {
  if (!clientPromise) {
    const client = new LspClient({
      command: resolveJdtlsCommand(),
      args: ["-data", javaLspConfig.JDTLS_DATA_DIR, ...(javaLspConfig.JAVA_EXECUTABLE ? ["--java-executable", javaLspConfig.JAVA_EXECUTABLE] : [])],
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

function resolveFile(file: string): string {
  const abs = path.resolve(WORKSPACE_ROOT, file);
  if (!abs.startsWith(path.resolve(WORKSPACE_ROOT) + path.sep) && abs !== path.resolve(WORKSPACE_ROOT)) {
    throw new Error(`Refusing to open a path outside the configured workspace root: ${file}`);
  }
  return abs;
}

async function withOpenFile<T>(log: (kind: string, message: string) => void, file: string, fn: (client: LspClient, uri: string) => Promise<T> | T): Promise<T> {
  const client = await getClient(log);
  const abs = resolveFile(file);
  const uri = await client.syncFile(abs, "java");
  return fn(client, uri);
}

type ToolResult = { success: true; data: unknown } | { success: false; error: string };

async function toolResult(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err instanceof LspClientError ? err.message : String((err as Error)?.message ?? err) };
  }
}

interface PositionArgs {
  file: string;
  line: number;
  character: number;
}

function createMcpServer(): Server {
  const server = new Server({ name: "java-lsp-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  const log = (kind: string, message: string) => console.error(`[jdtls:${kind}]`, message.toString().slice(0, 500));

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
    const { name, arguments: rawArgs } = request.params;
    const args = rawArgs as unknown as PositionArgs & { includeDeclaration?: boolean; query?: string; waitMs?: number };
    const position = () => ({ line: args.line, character: args.character });

    let result: ToolResult;
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

httpServer.listen(serverConfig.JAVA_LSP_MCP_PORT, () => {
  console.error(`Java LSP MCP server listening on http://localhost:${serverConfig.JAVA_LSP_MCP_PORT}/mcp`);
});

process.on("SIGTERM", async () => {
  if (clientPromise) await clientPromise.then((c) => c.shutdown(), () => {});
  process.exit(0);
});
