#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { LspClient, LspClientError } from "./lsp-client.js";
import type { ServerConfig, SpringLspConfig } from "./types/config.js";
import { buildClasspathEvent } from "./classpath.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8093; // the next free port after mcp-servers/java-lsp's 8092
const CONFIG_DIR = path.join(homedir(), ".config", "kealthas-dev", "opencode-mcp-spring-lsp");
const SERVER_CONFIG_PATH = path.join(CONFIG_DIR, "server.json");

const SAMPLE_SERVER_CONFIG = { SPRING_LSP_MCP_PORT: DEFAULT_PORT };
const SAMPLE_SPRING_LSP_CONFIG = {
  SPRING_LSP_WORKSPACE_ROOT: "/path/to/your/spring-boot/project",
  KEALTHAS_SPRING_LSP_LAUNCHER_JAVA_EXECUTABLE: "/path/to/jdk21/bin/java (optional, defaults to java on PATH)",
  KEALTHAS_SPRING_LSP_MAVEN_COMMAND: "/path/to/mvn (optional, defaults to mvn on PATH)",
};

function printSampleConfig(label: string, path_: string, sample: unknown): void {
  console.error(`\nExpected ${label} at: ${path_}\n`);
  console.error(JSON.stringify(sample, null, 2));
  console.error("");
}

// SPRING_LSP_MCP_PORT env var overrides server.json, for running several
// instances (different projects/ports) without separate port files.
function loadServerConfig(): ServerConfig {
  if (process.env.SPRING_LSP_MCP_PORT !== undefined) {
    const port = Number(process.env.SPRING_LSP_MCP_PORT);
    if (!Number.isInteger(port) || port <= 0) {
      console.error(`SPRING_LSP_MCP_PORT must be a positive integer, got: ${JSON.stringify(process.env.SPRING_LSP_MCP_PORT)}`);
      process.exit(1);
    }
    return { SPRING_LSP_MCP_PORT: port };
  }

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

// config.json by default, config-<name>.json when SPRING_LSP_CONFIG_ENV is set.
function loadSpringLspConfig(): SpringLspConfig {
  const envName = process.env.SPRING_LSP_CONFIG_ENV;
  const resolvedPath = path.join(CONFIG_DIR, envName ? `config-${envName}.json` : "config.json");
  if (!existsSync(resolvedPath)) {
    console.error(`spring-lsp config file not found: ${resolvedPath}`);
    printSampleConfig("spring-lsp config file", resolvedPath, SAMPLE_SPRING_LSP_CONFIG);
    process.exit(1);
  }

  try {
    const raw = JSON.parse(readFileSync(resolvedPath, "utf8"));
    if (!raw.SPRING_LSP_WORKSPACE_ROOT) {
      throw new Error("missing required key SPRING_LSP_WORKSPACE_ROOT (the Spring Boot project root to analyze)");
    }
    return {
      SPRING_LSP_WORKSPACE_ROOT: raw.SPRING_LSP_WORKSPACE_ROOT,
      KEALTHAS_SPRING_LSP_LAUNCHER_JAVA_EXECUTABLE: raw.KEALTHAS_SPRING_LSP_LAUNCHER_JAVA_EXECUTABLE,
      KEALTHAS_SPRING_LSP_MAVEN_COMMAND: raw.KEALTHAS_SPRING_LSP_MAVEN_COMMAND,
    };
  } catch (err) {
    console.error(`Failed to load spring-lsp config from ${resolvedPath}: ${(err as Error).message}`);
    // A raw Windows path like "C:\Users\x\project" typed into JSON without
    // escaping its backslashes breaks JSON.parse with a cryptic "Unexpected
    // token"/"Bad control character" error that gives no hint what's wrong -
    // this is the single most likely way a Windows user's config fails.
    if (err instanceof SyntaxError && process.platform === "win32") {
      console.error("If this file has a Windows path like \"C:\\Users\\...\", either escape every backslash (\"C:\\\\Users\\\\...\") or just use forward slashes instead (\"C:/Users/...\") - Node accepts both on Windows, and forward slashes need no escaping in JSON.");
    }
    printSampleConfig("spring-lsp config file", resolvedPath, SAMPLE_SPRING_LSP_CONFIG);
    process.exit(1);
  }
}

const serverConfig = loadServerConfig();
const springLspConfig = loadSpringLspConfig();
const WORKSPACE_ROOT = springLspConfig.SPRING_LSP_WORKSPACE_ROOT;
const JAVA_EXECUTABLE = springLspConfig.KEALTHAS_SPRING_LSP_LAUNCHER_JAVA_EXECUTABLE ?? "java"; // spring-boot-language-server itself needs JDK 21+ - see README's "JDK version"

// The vendored tarball was packed on macOS and carries "._*" AppleDouble
// sidecar files (one per real file, including "._<name>-exec.jar"); GNU tar
// on Windows/Linux extracts them as ordinary files, and one sorts ahead of the
// real jar - so match on the real name only.
const isExecJar = (f: string): boolean => f.endsWith("-exec.jar") && !f.startsWith("._");

const toPosix = (p: string): string => p.replaceAll("\\", "/");

// Runs a vendor-setup command (mkdir/tar) with a clear, actionable error on
// failure instead of a raw Node stack trace - in particular distinguishing
// "the command isn't on PATH at all" (e.g. GNU coreutils missing on Windows
// outside Git Bash/WSL) from "the command ran and failed" (stderr already
// captured in the thrown error by execFileSync's default 'pipe' stdio).
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

// vendor/spring-boot-language-server-<version>.tar.gz is committed (not
// published to any registry - see fetch-spring-boot-language-server.sh),
// extracted lazily on first startup rather than at npm-install time - a
// `git pull` that bumps the tarball is picked up automatically, no separate
// build step.
function resolveLanguageServerDir(): { dir: string; jarName: string } {
  const vendorDir = path.join(here, "..", "vendor");
  const tarball = readdirSync(vendorDir).find((f) => f.endsWith(".tar.gz"));
  if (!tarball) {
    throw new Error(`No spring-boot-language-server-*.tar.gz found in ${vendorDir} - run fetch-spring-boot-language-server.sh first.`);
  }
  const version = tarball.replace(/^spring-boot-language-server-/, "").replace(/\.tar\.gz$/, "");
  const extractedDir = path.join(vendorDir, `spring-boot-language-server-${version}`);
  const execJarGlob = existsSync(extractedDir) ? readdirSync(extractedDir).find(isExecJar) : undefined;
  if (!existsSync(extractedDir) || !execJarGlob) {
    console.error(`Extracting ${tarball} into ${extractedDir} (first run only)...`);
    runVendorSetupCommand("mkdir", ["-p", extractedDir], `Failed to create ${extractedDir}`);
    // Forward slashes, not the native path: Git for Windows' GNU tar fails to
    // open a backslash path ("Cannot open: No such file or directory"), and
    // --force-local alone doesn't fix that. --force-local is still needed on
    // top: with a drive-letter colon (or an "@" from an npm scope dir, as in
    // node_modules/@kealthas-dev/...) tar otherwise treats the path as a
    // remote host:file spec. Windows only: macOS's bsdtar rejects the option
    // ("Option --force-local is not supported") and has no such parsing.
    runVendorSetupCommand(
      "tar",
      ["-xzf", toPosix(path.join(vendorDir, tarball)), "-C", toPosix(extractedDir), ...(process.platform === "win32" ? ["--force-local"] : [])],
      `Failed to extract ${tarball} into ${extractedDir}`,
    );
    console.error(`Extracted ${tarball}.`);
  }
  const execJar = readdirSync(extractedDir).find(isExecJar);
  if (!execJar) throw new Error(`Extracted ${extractedDir} but found no *-exec.jar inside it.`);
  return { dir: extractedDir, jarName: execJar };
}

const LINE_CHAR_DESCRIPTION =
  "0-indexed, per the LSP spec (not the 1-indexed line numbers most editors display) - line 0 is the file's first line, character 0 is the first column.";

// Same reasoning as java-lsp/src/server.ts: one persistent process for the
// server's whole lifetime, not one per request - see that file's comments.
let clientPromise: Promise<LspClient> | undefined;

// spring-boot-language-server gets a project's classpath from its client, not by itself: right after startup it
// sends sts/addClasspathListener and waits for the client to call back the command id it registered with the
// project's classpath (VS Code's Java extension supplies this; standalone, nothing does and every tool answers
// empty after a ~15s timeout). Computed once from Maven, in the background, so it is usually ready by the time
// the server asks; a project without a pom.xml, or a failed Maven run, just leaves the server without one.
const classpathEvent = (async () => {
  try {
    return await buildClasspathEvent(WORKSPACE_ROOT, springLspConfig.KEALTHAS_SPRING_LSP_MAVEN_COMMAND ?? "mvn", JAVA_EXECUTABLE);
  } catch (err) {
    console.error(`Could not compute the project's classpath with Maven (${(err as Error).message}) - spring_* tools will return little or nothing.`);
    return undefined;
  }
})();

function getClient(log: (kind: string, message: string) => void): Promise<LspClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      // Start the language server only once the classpath is ready: it gives up on the listener after ~15s and
      // never asks again, so an event that arrives later than that would be dropped for the process's lifetime.
      await classpathEvent;
      const { dir, jarName } = resolveLanguageServerDir();
      const client: LspClient = new LspClient({
        command: JAVA_EXECUTABLE,
        args: ["-jar", jarName],
        spawnOptions: { cwd: dir },
        rootPath: WORKSPACE_ROOT,
        log,
        onServerRequest: (method, params) => {
          if (method !== "sts/addClasspathListener") return null;
          const { callbackCommandId } = params as { callbackCommandId: string };
          void classpathEvent.then((event) => {
            if (!event) return;
            client.request("workspace/executeCommand", { command: callbackCommandId, arguments: [[event.projectUri, event.name, event.deleted, event.classpath, event.projectBuild, event.javaCoreOptions]] }).catch((e) => log("error", `classpath callback failed: ${(e as Error).message}`));
          });
          return null;
        },
      });
      await client.start();
      return client;
    })().catch((err) => {
      clientPromise = undefined; // allow retry on the next call instead of caching a permanent failure
      throw err;
    });
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

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "spring-lsp-mcp", version: "1.0.0" });
  const log = (kind: string, message: string) => console.error(`[spring-boot-ls:${kind}]`, message.toString().slice(0, 500));
  const respond = (result: ToolResult) => ({ content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] });

  const filePathShape = z.string().describe(`Path to a .java/.properties/.yml file, absolute or relative to ${WORKSPACE_ROOT}.`);
  const positionShape = { file: filePathShape, line: z.number().describe(LINE_CHAR_DESCRIPTION), character: z.number().describe(LINE_CHAR_DESCRIPTION) };
  const position = (args: { line: number; character: number }) => ({ line: args.line, character: args.character });

  server.registerTool(
    "spring_hover",
    {
      description:
        "Get Spring-aware info for the symbol/property at a position - e.g. a Spring Boot config property's real type, default, and description straight from the project's actual spring-configuration-metadata.json, not just plain Java type info. Works on .java, .properties, and .yml files.",
      inputSchema: positionShape,
    },
    async (args) => respond(await toolResult(() => withOpenFile(log, args.file, (client, uri) => client.request("textDocument/hover", { textDocument: { uri }, position: position(args) })))),
  );

  server.registerTool(
    "spring_completion",
    {
      description:
        "Get completion suggestions at a position - the standout use case is a .properties/.yml file, where this suggests real Spring Boot configuration property names (from the project's actual resolved dependencies) instead of guessing at property names from memory.",
      inputSchema: positionShape,
    },
    async (args) => respond(await toolResult(() => withOpenFile(log, args.file, (client, uri) => client.request("textDocument/completion", { textDocument: { uri }, position: position(args) })))),
  );

  server.registerTool(
    "spring_document_symbols",
    {
      description: "List symbols in one file, structurally (same shape as mcp-servers/java-lsp's java_document_symbols, via this server's own JDT-based parsing).",
      inputSchema: { file: filePathShape },
    },
    async (args) => respond(await toolResult(() => withOpenFile(log, args.file, (client, uri) => client.request("textDocument/documentSymbol", { textDocument: { uri } })))),
  );

  server.registerTool(
    "spring_workspace_symbols",
    { description: "Fuzzy-search declared symbols by name across the workspace this server has indexed.", inputSchema: { query: z.string().describe("Symbol name or fragment to search for.") } },
    async (args) =>
      respond(
        await toolResult(async () => {
          const client = await getClient(log);
          return client.request("workspace/symbol", { query: args.query });
        }),
      ),
  );

  server.registerTool(
    "spring_diagnostics",
    {
      description:
        "Get this server's current diagnostics for one file (opens/syncs it first, then returns whatever's been published for it - includes Spring-specific checks, e.g. an unresolvable @Autowired bean, not just Java compile errors).",
      inputSchema: { file: filePathShape, waitMs: z.number().optional().describe("How long to wait for diagnostics after opening the file, in ms. Defaults to 3000.") },
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

  server.registerTool(
    "spring_boot_structure",
    {
      description:
        "Get this project's Spring Boot application structure (beans, request mappings, etc.) via the server's own 'sts/spring-boot/structure' custom LSP command - the actual bean-graph info generic Java tooling has no access to. Returns an empty result (not an error) if this workspace has no live/indexed Spring Boot application context yet.",
    },
    async () =>
      respond(
        await toolResult(async () => {
          const client = await getClient(log);
          const rootUri = pathToFileURL(path.resolve(WORKSPACE_ROOT)).href;
          return client.request("workspace/executeCommand", {
            command: "sts/spring-boot/structure",
            arguments: [{ identifier: rootUri }],
          });
        }),
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
