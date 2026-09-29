#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
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
  JDTLS_LAUNCHER_JAVA_EXECUTABLE: "/path/to/jdk21/bin/java (optional, launches jdtls itself, must be 21+ - see README.md's JDK version section)",
  ANALYZED_PROJECT_JDK_RUNTIMES: [{ name: "JavaSE-1.8", path: "/path/to/jdk8 (a JDK home, not bin/java)", default: true }],
};

function printSampleConfig(label: string, path_: string, sample: unknown): void {
  console.error(`\nExpected ${label} at: ${path_}\n`);
  console.error(JSON.stringify(sample, null, 2));
  console.error("");
}

// JAVA_LSP_MCP_PORT env var overrides server.json, for running several
// instances (different projects/ports) without separate port files.
function loadServerConfig(): ServerConfig {
  if (process.env.JAVA_LSP_MCP_PORT !== undefined) {
    const port = Number(process.env.JAVA_LSP_MCP_PORT);
    if (!Number.isInteger(port) || port <= 0) {
      console.error(`JAVA_LSP_MCP_PORT must be a positive integer, got: ${JSON.stringify(process.env.JAVA_LSP_MCP_PORT)}`);
      process.exit(1);
    }
    return { JAVA_LSP_MCP_PORT: port };
  }

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

// config.json by default, config-<name>.json when JAVA_LSP_CONFIG_ENV is set.
function loadJavaLspConfig(): JavaLspConfig {
  const envName = process.env.JAVA_LSP_CONFIG_ENV;
  const resolvedPath = path.join(CONFIG_DIR, envName ? `config-${envName}.json` : "config.json");
  if (!existsSync(resolvedPath)) {
    console.error(`java-lsp config file not found: ${resolvedPath}`);
    printSampleConfig("java-lsp config file", resolvedPath, SAMPLE_JAVA_LSP_CONFIG);
    process.exit(1);
  }

  try {
    const raw = JSON.parse(readFileSync(resolvedPath, "utf8"));
    const { JAVA_LSP_WORKSPACE_ROOT, JDTLS_DATA_DIR, JDTLS_COMMAND, JDTLS_LAUNCHER_JAVA_EXECUTABLE, ANALYZED_PROJECT_JDK_RUNTIMES } = raw;
    if (!JAVA_LSP_WORKSPACE_ROOT) {
      throw new Error("missing required key JAVA_LSP_WORKSPACE_ROOT (the Java project root jdtls should analyze)");
    }
    if (!JDTLS_DATA_DIR) {
      throw new Error(
        "missing required key JDTLS_DATA_DIR (jdtls's own workspace/index storage directory, its -data flag, " +
          "not the project root - use a directory dedicated to this one project)",
      );
    }
    return { JAVA_LSP_WORKSPACE_ROOT, JDTLS_DATA_DIR, JDTLS_COMMAND, JDTLS_LAUNCHER_JAVA_EXECUTABLE, ANALYZED_PROJECT_JDK_RUNTIMES };
  } catch (err) {
    console.error(`Failed to load java-lsp config from ${resolvedPath}: ${(err as Error).message}`);
    // A raw Windows path like "C:\Users\x\project" typed into JSON without
    // escaping its backslashes breaks JSON.parse with a cryptic "Unexpected
    // token"/"Bad control character" error that gives no hint what's wrong -
    // this is the single most likely way a Windows user's config fails.
    if (err instanceof SyntaxError && process.platform === "win32") {
      console.error("If this file has a Windows path like \"C:\\Users\\...\", either escape every backslash (\"C:\\\\Users\\\\...\") or just use forward slashes instead (\"C:/Users/...\") - Node accepts both on Windows, and forward slashes need no escaping in JSON.");
    }
    printSampleConfig("java-lsp config file", resolvedPath, SAMPLE_JAVA_LSP_CONFIG);
    process.exit(1);
  }
}

const serverConfig = loadServerConfig();
const javaLspConfig = loadJavaLspConfig();
const WORKSPACE_ROOT = javaLspConfig.JAVA_LSP_WORKSPACE_ROOT;

const LINE_CHAR_DESCRIPTION =
  "0-indexed, per the LSP spec (not the 1-indexed line numbers most editors display) - line 0 is the file's first line, character 0 is the first column.";

// Runs a vendor-setup command (mkdir/tar) with a clear, actionable error on
// failure instead of a raw Node stack trace - in particular distinguishing
// "the command isn't on PATH at all" (e.g. GNU coreutils missing on Windows
// outside Git Bash/WSL) from "the command ran and failed" (stderr already
// captured in the thrown error by execFileSync's default 'pipe' stdio).
const toPosix = (p: string): string => p.replaceAll("\\", "/");

function runVendorSetupCommand(command: string, args: string[], failureContext: string): void {
  try {
    execFileSync(command, args);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    if (e.code === "ENOENT") {
      throw new Error(
        `${failureContext}: \`${command}\` isn't on PATH. This server needs GNU coreutils (mkdir, tar) on ` +
          `PATH - on Windows, run it from Git Bash or WSL, not plain cmd.exe/PowerShell.`,
      );
    }
    throw new Error(`${failureContext}: ${e.stderr?.toString("utf8").trim() || e.message}`);
  }
}

// The official python.org Windows installer provides python.exe and the py
// launcher but no python3.exe, and the Microsoft Store's python3.exe is a stub
// that exits non-zero - so probe by actually running --version instead of
// assuming a name.
function findWindowsPython(): { command: string; args: string[] } {
  const candidates = [
    { command: "python3", args: [] as string[] },
    { command: "python", args: [] as string[] },
    { command: "py", args: ["-3"] },
  ];
  for (const c of candidates) {
    const r = spawnSync(c.command, [...c.args, "--version"], { encoding: "utf8" });
    if (r.status === 0 && /^Python 3\./.test(`${r.stdout}${r.stderr}`.trim())) return c;
  }
  throw new Error(
    "jdtls's launcher needs Python 3, but none of `python3`, `python`, `py -3` runs on PATH (the Microsoft Store's python3 stub doesn't count).",
  );
}

// vendor/jdt-language-server-<version>.tar.gz is committed (see README's
// Vendoring section), extracted lazily on first startup rather than at
// npm-install time - a `git pull` that bumps the tarball is picked up
// automatically, no separate build step (mirrors spring-lsp's equivalent).
// JDTLS_COMMAND overrides this entirely, e.g. to a system-installed jdtls.
function resolveJdtlsCommand(): { command: string; prefixArgs: string[] } {
  if (javaLspConfig.JDTLS_COMMAND) return { command: javaLspConfig.JDTLS_COMMAND, prefixArgs: [] };
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
    runVendorSetupCommand("mkdir", ["-p", extractedDir], `Failed to create ${extractedDir}`);
    // Forward slashes, not the native path: Git for Windows' GNU tar fails to
    // open a backslash path ("Cannot open: No such file or directory"), and
    // --force-local alone doesn't fix that. --force-local is still needed on
    // top: with a drive-letter colon (or an "@" from an npm scope dir, as in
    // node_modules/@kealthas-dev/...) tar otherwise treats the path as a
    // remote host:file spec.
    runVendorSetupCommand(
      "tar",
      ["-xzf", toPosix(path.join(vendorDir, tarball)), "-C", toPosix(extractedDir), "--force-local"],
      `Failed to extract ${tarball} into ${extractedDir}`,
    );
    console.error(`Extracted ${tarball}.`);
  }
  // bin/jdtls is Eclipse's own python launcher script - a POSIX shebang
  // script with no .exe/.bat/.cmd. macOS/Linux's spawn() reads the shebang
  // itself and runs it fine, but Windows has no shebang support at all -
  // spawn() there fails with ENOENT trying to launch the script directly.
  // Invoke a Python 3 interpreter on it explicitly there instead.
  if (process.platform === "win32") {
    const python = findWindowsPython();
    return { command: python.command, prefixArgs: [...python.args, launcher] };
  }
  return { command: launcher, prefixArgs: [] };
}

// One jdtls process per server lifetime, not per request - unlike oracle/loki's
// per-request model, LSP is genuinely stateful (indexing takes seconds; jdtls
// doesn't support concurrent instances against one -data dir anyway). Started
// lazily on first tool call so the HTTP server itself comes up immediately.
let clientPromise: Promise<LspClient> | undefined;
function getClient(log: (kind: string, message: string) => void): Promise<LspClient> {
  if (!clientPromise) {
    const { command, prefixArgs } = resolveJdtlsCommand();
    const client = new LspClient({
      command,
      args: [...prefixArgs, "-data", javaLspConfig.JDTLS_DATA_DIR, ...(javaLspConfig.JDTLS_LAUNCHER_JAVA_EXECUTABLE ? ["--java-executable", javaLspConfig.JDTLS_LAUNCHER_JAVA_EXECUTABLE] : [])],
      rootPath: WORKSPACE_ROOT,
      log,
    });
    clientPromise = client.start().then(
      () => {
        // The JDKs the *analyzed project* builds against - independent of the
        // JDK 21+ that launches jdtls itself (see README's "JDK version").
        if (javaLspConfig.ANALYZED_PROJECT_JDK_RUNTIMES?.length) {
          client.notify("workspace/didChangeConfiguration", {
            settings: { java: { configuration: { runtimes: javaLspConfig.ANALYZED_PROJECT_JDK_RUNTIMES } } },
          });
        }
        return client;
      },
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

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "java-lsp-mcp", version: "1.0.0" });
  const log = (kind: string, message: string) => console.error(`[jdtls:${kind}]`, message.toString().slice(0, 500));
  const respond = (result: ToolResult) => ({ content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] });

  const filePathShape = z.string().describe(`Path to a .java file, absolute or relative to ${WORKSPACE_ROOT}.`);
  const positionShape = { file: filePathShape, line: z.number().describe(LINE_CHAR_DESCRIPTION), character: z.number().describe(LINE_CHAR_DESCRIPTION) };
  const position = (args: { line: number; character: number }) => ({ line: args.line, character: args.character });

  server.registerTool(
    "java_definition",
    {
      description:
        "Jump to the definition of the Java symbol at a position, using jdtls's real type resolution (not text search) - handles overloads, inheritance, and cross-file references correctly.",
      inputSchema: positionShape,
    },
    async (args) => respond(await toolResult(() => withOpenFile(log, args.file, (client, uri) => client.request("textDocument/definition", { textDocument: { uri }, position: position(args) })))),
  );

  server.registerTool(
    "java_references",
    {
      description: "Find every real usage of the Java symbol at a position across the workspace (scope-aware, not a name-text grep).",
      inputSchema: { ...positionShape, includeDeclaration: z.boolean().optional().describe("Include the declaration itself in the results. Defaults to true.") },
    },
    async (args) =>
      respond(
        await toolResult(() =>
          withOpenFile(log, args.file, (client, uri) =>
            client.request("textDocument/references", {
              textDocument: { uri },
              position: position(args),
              context: { includeDeclaration: args.includeDeclaration ?? true },
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "java_hover",
    { description: "Get the resolved type signature and Javadoc for the Java symbol at a position.", inputSchema: positionShape },
    async (args) => respond(await toolResult(() => withOpenFile(log, args.file, (client, uri) => client.request("textDocument/hover", { textDocument: { uri }, position: position(args) })))),
  );

  server.registerTool(
    "java_implementation",
    { description: "Jump from an interface or abstract method to its concrete implementation(s).", inputSchema: positionShape },
    async (args) =>
      respond(await toolResult(() => withOpenFile(log, args.file, (client, uri) => client.request("textDocument/implementation", { textDocument: { uri }, position: position(args) })))),
  );

  server.registerTool(
    "java_document_symbols",
    {
      description: "List every class/method/field jdtls actually parsed out of one Java file, with kind and precise location - structural, not a text search.",
      inputSchema: { file: filePathShape },
    },
    async (args) => respond(await toolResult(() => withOpenFile(log, args.file, (client, uri) => client.request("textDocument/documentSymbol", { textDocument: { uri } })))),
  );

  server.registerTool(
    "java_workspace_symbols",
    {
      description:
        "Fuzzy-search real declared symbols (classes/methods/fields) by name across the whole workspace jdtls has indexed - matches against jdtls's own symbol index, not file contents, so it won't match a name that only appears in a comment or string literal.",
      inputSchema: { query: z.string().describe("Symbol name or fragment to search for.") },
    },
    async (args) =>
      respond(
        await toolResult(async () => {
          const client = await getClient(log);
          return client.request("workspace/symbol", { query: args.query });
        }),
      ),
  );

  server.registerTool(
    "java_diagnostics",
    {
      description: "Get jdtls's current compile errors/warnings for one Java file (opens/syncs the file first, then returns whatever diagnostics jdtls has published for it).",
      inputSchema: { file: filePathShape, waitMs: z.number().optional().describe("How long to wait for jdtls to publish diagnostics after opening the file, in ms. Defaults to 3000.") },
    },
    async (args) =>
      respond(
        await toolResult(() =>
          withOpenFile(log, args.file, async (client, uri) => {
            await new Promise((r) => setTimeout(r, args.waitMs ?? 3000));
            return client.getDiagnostics(uri);
          }),
        ),
      ),
  );

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

  // Stateless at the MCP/HTTP layer only (fresh pair per request, like
  // oracle/loki) - jdtls itself is the stateful thing, a module-level
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
