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
import type { ServerConfig, SpringLspConfig } from "./types/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8093; // the next free port after mcp-servers/java-lsp's 8092
const CONFIG_DIR = path.join(homedir(), ".config", "kealthas-dev", "opencode-mcp-spring-lsp");
const SERVER_CONFIG_PATH = path.join(CONFIG_DIR, "server.json");

const SAMPLE_SERVER_CONFIG = { SPRING_LSP_MCP_PORT: DEFAULT_PORT };
const SAMPLE_SPRING_LSP_CONFIG = {
  SPRING_LSP_WORKSPACE_ROOT: "/path/to/your/spring-boot/project",
  JAVA_EXECUTABLE: "/path/to/jdk21/bin/java (optional, defaults to java on PATH)",
};

function printSampleConfig(label: string, path_: string, sample: unknown): void {
  console.error(`\nExpected ${label} at: ${path_}\n`);
  console.error(JSON.stringify(sample, null, 2));
  console.error("");
}

// server.json is infrastructure config (which port to bind) that doesn't
// vary per environment, so it lives at one fixed path rather than being
// pointed at like the spring-lsp config below. Missing entirely just means
// "use the default port" - only a present-but-broken file is treated as a
// real error, since its existence signals intent to override the default.
function loadServerConfig(): ServerConfig {
  if (!existsSync(SERVER_CONFIG_PATH)) {
    return { SPRING_LSP_MCP_PORT: DEFAULT_PORT };
  }

  try {
    const raw = JSON.parse(readFileSync(SERVER_CONFIG_PATH, "utf8"));
    const port = Number(raw.SPRING_LSP_MCP_PORT ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`SPRING_LSP_MCP_PORT must be a positive integer, got: ${JSON.stringify(raw.SPRING_LSP_MCP_PORT)}`);
    }
    return { SPRING_LSP_MCP_PORT: port };
  } catch (err) {
    console.error(`Failed to load server config: ${(err as Error).message}`);
    printSampleConfig("server config", SERVER_CONFIG_PATH, SAMPLE_SERVER_CONFIG);
    process.exit(1);
  }
}

// The Spring Boot project to analyze is per-environment/per-project, but
// the *location* it's read from is never user-supplied - only a short env
// name is (e.g. "my-project"), which selects a fixed file under
// CONFIG_DIR/configs/. This avoids the class of bug an arbitrary-path env
// var invites: a caller's shell not expanding "~", a quoted value
// suppressing that expansion, a typo'd relative path resolving against
// whatever cwd happens to be - all of which point path.resolve() somewhere
// unintended, silently. A bare name has none of that surface. No env var
// set falls back to config.json directly in CONFIG_DIR (not configs/) for
// the common single-project case.
const DEFAULT_SPRING_LSP_CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const SPRING_LSP_CONFIGS_DIR = path.join(CONFIG_DIR, "configs");
const CONFIG_ENV_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function loadSpringLspConfig(): SpringLspConfig {
  const envName = process.env.SPRING_LSP_CONFIG_ENV;
  if (envName !== undefined && !CONFIG_ENV_NAME_RE.test(envName)) {
    console.error(`SPRING_LSP_CONFIG_ENV must be a plain name (letters, digits, "-", "_"), got: ${JSON.stringify(envName)}`);
    process.exit(1);
  }
  const resolvedPath = envName ? path.join(SPRING_LSP_CONFIGS_DIR, `${envName}.json`) : DEFAULT_SPRING_LSP_CONFIG_PATH;
  if (!existsSync(resolvedPath)) {
    if (envName) {
      console.error(`spring-lsp config file not found: ${resolvedPath}`);
      console.error(`(SPRING_LSP_CONFIG_ENV=${envName} looks for "${envName}.json" under ${SPRING_LSP_CONFIGS_DIR})`);
    } else {
      console.error(`No SPRING_LSP_CONFIG_ENV set and no default config file at: ${resolvedPath}`);
      console.error(`Either create that file, or set SPRING_LSP_CONFIG_ENV to the name of a file under ${SPRING_LSP_CONFIGS_DIR}/, e.g.:`);
      console.error("  SPRING_LSP_CONFIG_ENV=my-project opencode-mcp-spring-lsp");
    }
    printSampleConfig("spring-lsp config file", resolvedPath, SAMPLE_SPRING_LSP_CONFIG);
    process.exit(1);
  }

  try {
    const raw = JSON.parse(readFileSync(resolvedPath, "utf8"));
    if (!raw.SPRING_LSP_WORKSPACE_ROOT) {
      throw new Error("missing required key SPRING_LSP_WORKSPACE_ROOT (the Spring Boot project root to analyze)");
    }
    return { SPRING_LSP_WORKSPACE_ROOT: raw.SPRING_LSP_WORKSPACE_ROOT, JAVA_EXECUTABLE: raw.JAVA_EXECUTABLE };
  } catch (err) {
    console.error(`Failed to load spring-lsp config from ${resolvedPath}: ${(err as Error).message}`);
    printSampleConfig("spring-lsp config file", resolvedPath, SAMPLE_SPRING_LSP_CONFIG);
    process.exit(1);
  }
}

const serverConfig = loadServerConfig();
const springLspConfig = loadSpringLspConfig();
const WORKSPACE_ROOT = springLspConfig.SPRING_LSP_WORKSPACE_ROOT;
const JAVA_EXECUTABLE = springLspConfig.JAVA_EXECUTABLE ?? "java"; // spring-boot-language-server itself needs JDK 21+ - see README's "JDK version"

// vendor/spring-boot-language-server-<version>.tar.gz is committed (see
// fetch-spring-boot-language-server.sh's own comments for why: it's not
// published to any package registry). Extracted lazily on first startup
// into a sibling directory, not at npm-install time - this way a
// `git pull` that bumps the vendored tarball is picked up automatically
// without a separate build step.
function resolveLanguageServerDir(): { dir: string; jarName: string } {
  const vendorDir = path.join(here, "..", "vendor");
  const tarball = readdirSync(vendorDir).find((f) => f.endsWith(".tar.gz"));
  if (!tarball) {
    throw new Error(`No spring-boot-language-server-*.tar.gz found in ${vendorDir} - run fetch-spring-boot-language-server.sh first.`);
  }
  const version = tarball.replace(/^spring-boot-language-server-/, "").replace(/\.tar\.gz$/, "");
  const extractedDir = path.join(vendorDir, `spring-boot-language-server-${version}`);
  const execJarGlob = existsSync(extractedDir) ? readdirSync(extractedDir).find((f) => f.endsWith("-exec.jar")) : undefined;
  if (!existsSync(extractedDir) || !execJarGlob) {
    console.error(`Extracting ${tarball} into ${extractedDir} (first run only)...`);
    execFileSync("mkdir", ["-p", extractedDir]);
    execFileSync("tar", ["-xzf", path.join(vendorDir, tarball), "-C", extractedDir]);
  }
  const execJar = readdirSync(extractedDir).find((f) => f.endsWith("-exec.jar"));
  if (!execJar) throw new Error(`Extracted ${extractedDir} but found no *-exec.jar inside it.`);
  return { dir: extractedDir, jarName: execJar };
}

const LINE_CHAR_DESCRIPTION =
  "0-indexed, per the LSP spec (not the 1-indexed line numbers most editors display) - line 0 is the file's first line, character 0 is the first column.";

// Same reasoning as mcp-servers/java-lsp/src/server.ts: one persistent language-server
// process for the server's whole lifetime (module-level singleton), not
// one per request - see that file's comments for why. Copied rather than
// shared for the same reason lsp-client.ts is copied - see both READMEs.
let clientPromise: Promise<LspClient> | undefined;
function getClient(log: (kind: string, message: string) => void): Promise<LspClient> {
  if (!clientPromise) {
    const { dir, jarName } = resolveLanguageServerDir();
    const client = new LspClient({
      command: JAVA_EXECUTABLE,
      args: ["-jar", jarName],
      spawnOptions: { cwd: dir },
      rootPath: WORKSPACE_ROOT,
      log,
    });
    clientPromise = client.start().then(
      () => client,
      (err) => {
        clientPromise = undefined;
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

function languageIdFor(file: string): string {
  if (file.endsWith(".java")) return "java";
  if (file.endsWith(".yml") || file.endsWith(".yaml")) return "spring-boot-yaml";
  if (file.endsWith(".properties")) return "spring-boot-properties";
  return "plaintext";
}

async function withOpenFile<T>(log: (kind: string, message: string) => void, file: string, fn: (client: LspClient, uri: string) => Promise<T> | T): Promise<T> {
  const client = await getClient(log);
  const abs = resolveFile(file);
  const uri = await client.syncFile(abs, languageIdFor(file));
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

interface ToolArgs {
  file: string;
  line: number;
  character: number;
  query?: string;
  waitMs?: number;
}

function createMcpServer(): Server {
  const server = new Server({ name: "spring-lsp-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  const log = (kind: string, message: string) => console.error(`[spring-boot-ls:${kind}]`, message.toString().slice(0, 500));

  const filePathProp = { type: "string", description: `Path to a .java/.properties/.yml file, absolute or relative to ${WORKSPACE_ROOT}.` };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "spring_hover",
        description:
          "Get Spring-aware info for the symbol/property at a position - e.g. a Spring Boot config property's real type, default, and description straight from the project's actual spring-configuration-metadata.json, not just plain Java type info. Works on .java, .properties, and .yml files.",
        inputSchema: {
          type: "object",
          properties: { file: filePathProp, line: { type: "number", description: LINE_CHAR_DESCRIPTION }, character: { type: "number", description: LINE_CHAR_DESCRIPTION } },
          required: ["file", "line", "character"],
        },
      },
      {
        name: "spring_completion",
        description:
          "Get completion suggestions at a position - the standout use case is a .properties/.yml file, where this suggests real Spring Boot configuration property names (from the project's actual resolved dependencies) instead of guessing at property names from memory.",
        inputSchema: {
          type: "object",
          properties: { file: filePathProp, line: { type: "number", description: LINE_CHAR_DESCRIPTION }, character: { type: "number", description: LINE_CHAR_DESCRIPTION } },
          required: ["file", "line", "character"],
        },
      },
      {
        name: "spring_document_symbols",
        description: "List symbols in one file, structurally (same shape as mcp-servers/java-lsp's java_document_symbols, via this server's own JDT-based parsing).",
        inputSchema: { type: "object", properties: { file: filePathProp }, required: ["file"] },
      },
      {
        name: "spring_workspace_symbols",
        description: "Fuzzy-search declared symbols by name across the workspace this server has indexed.",
        inputSchema: { type: "object", properties: { query: { type: "string", description: "Symbol name or fragment to search for." } }, required: ["query"] },
      },
      {
        name: "spring_diagnostics",
        description: "Get this server's current diagnostics for one file (opens/syncs it first, then returns whatever's been published for it - includes Spring-specific checks, e.g. an unresolvable @Autowired bean, not just Java compile errors).",
        inputSchema: {
          type: "object",
          properties: { file: filePathProp, waitMs: { type: "number", description: "How long to wait for diagnostics after opening the file, in ms. Defaults to 3000." } },
          required: ["file"],
        },
      },
      {
        name: "spring_boot_structure",
        description:
          "Get this project's Spring Boot application structure (beans, request mappings, etc.) via the server's own 'sts/spring-boot/structure' custom LSP command - the actual bean-graph info generic Java tooling has no access to. Returns an empty result (not an error) if this workspace has no live/indexed Spring Boot application context yet.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = rawArgs as unknown as ToolArgs;
    const position = () => ({ line: args.line, character: args.character });

    let result: ToolResult;
    switch (name) {
      case "spring_hover":
        result = await toolResult(() =>
          withOpenFile(log, args.file, (client, uri) => client.request("textDocument/hover", { textDocument: { uri }, position: position() })),
        );
        break;
      case "spring_completion":
        result = await toolResult(() =>
          withOpenFile(log, args.file, (client, uri) => client.request("textDocument/completion", { textDocument: { uri }, position: position() })),
        );
        break;
      case "spring_document_symbols":
        result = await toolResult(() =>
          withOpenFile(log, args.file, (client, uri) => client.request("textDocument/documentSymbol", { textDocument: { uri } })),
        );
        break;
      case "spring_workspace_symbols":
        result = await toolResult(async () => {
          const client = await getClient(log);
          return client.request("workspace/symbol", { query: args.query });
        });
        break;
      case "spring_diagnostics":
        result = await toolResult(() =>
          withOpenFile(log, args.file, async (client, uri) => {
            await new Promise((r) => setTimeout(r, args.waitMs ?? 3000));
            return client.getDiagnostics(uri);
          }),
        );
        break;
      case "spring_boot_structure":
        result = await toolResult(async () => {
          const client = await getClient(log);
          const rootUri = `file://${path.resolve(WORKSPACE_ROOT)}`;
          return client.request("workspace/executeCommand", {
            command: "sts/spring-boot/structure",
            arguments: [{ identifier: rootUri }],
          });
        });
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

httpServer.listen(serverConfig.SPRING_LSP_MCP_PORT, () => {
  console.error(`Spring LSP MCP server listening on http://localhost:${serverConfig.SPRING_LSP_MCP_PORT}/mcp`);
});

process.on("SIGTERM", async () => {
  if (clientPromise) await clientPromise.then((c) => c.shutdown(), () => {});
  process.exit(0);
});
