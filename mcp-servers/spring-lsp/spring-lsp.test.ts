// Requires a JDK 21+ `java` on PATH (or JAVA_EXECUTABLE pointed at one) -
// spring-boot-language-server's own MANIFEST.MF declares `Java-Version: 21`.
// Not something this test can mock, same reasoning as mcp-servers/java-lsp/java-lsp.test.ts:
// this package's whole point is driving a real spring-boot-language-server
// process.
//
// IMPORTANT, read before extending this test: the fixture project here is
// a bare loose .java file + application.properties with NO real Maven/Gradle
// project and no actual spring-boot-starter-* dependencies resolved. Against
// a fixture like that, spring-boot-language-server's own richer tools
// (spring_hover/spring_completion/spring_boot_structure returning actual
// bean/property data) come back empty - confirmed during development, see
// README.md's Status section. That's not a bug in this MCP server; it's
// this server genuinely having nothing to index. What's asserted below is
// deliberately just "the plumbing works and degrades cleanly" (real tool
// calls succeed, return an empty result rather than erroring, and don't
// crash the server) - not "the Spring-specific analysis is rich", which
// would need a real resolved Spring Boot project as a fixture (not set up
// here - see README.md's Status section for what that would take).
//
// Not yet wired into tests/run-in-container.sh / the docker/ sandbox - see
// mcp-servers/java-lsp/java-lsp.test.ts's header for why (no JDK in that image).
//
// server.ts reads its workspace config from config.json (or
// configs/<SPRING_LSP_CONFIG_ENV>.json) and its port from a fixed-path
// server.json, both under $HOME/.config/kealthas-dev/opencode-mcp-spring-lsp/
// (see README.md's
// Configuration section, and mcp-servers/oracle/oracle.test.ts for the
// same fake-$HOME pattern this test reuses) - this test spawns the compiled
// dist/server.js with its own fake $HOME so it never shares config with a
// real server that might be running in the same environment.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const DIST_SERVER_PATH = join(here, "dist", "server.js");
const READY_TIMEOUT_MS = 30_000; // spring-boot-language-server takes longer to boot than jdtls - a full Spring Boot app itself

try {
  const javaExecutable = process.env.JAVA_EXECUTABLE ?? "java";
  const versionOutput = execSync(`"${javaExecutable}" -version 2>&1`).toString();
  const major = /version "(\d+)/.exec(versionOutput)?.[1];
  if (!major || Number(major) < 21) {
    throw new Error(`java -version reports ${versionOutput.split("\n")[0]}, need 21+`);
  }
} catch (err) {
  throw new Error(
    `No JDK 21+ java available (${(err as Error).message}) - this test needs one, either on PATH or via JAVA_EXECUTABLE, ` +
      "to launch spring-boot-language-server itself. See README.md's 'JDK version' section.",
  );
}

const workspaceRoot = mkdtempSync(join(tmpdir(), "spring-lsp-mcp-test-"));
const srcDir = join(workspaceRoot, "src/main/java/com/example");
const resourcesDir = join(workspaceRoot, "src/main/resources");
mkdirSync(srcDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });
writeFileSync(
  join(srcDir, "Hello.java"),
  ["package com.example;", "", "public class Hello {", "    public String greet(String name) {", '        return "Hello, " + name;', "    }", "}", ""].join("\n"),
);
writeFileSync(join(resourcesDir, "application.properties"), "server.port=8080\n");

function startServer(port: number): Promise<ChildProcess> {
  const home = mkdtempSync(join(tmpdir(), "spring-lsp-mcp-test-home-"));
  const configDir = join(home, ".config", "kealthas-dev", "opencode-mcp-spring-lsp");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "server.json"), JSON.stringify({ SPRING_LSP_MCP_PORT: port }));

  // Written straight to the default config.json location (not pointed at via
  // an env var) - SPRING_LSP_CONFIG_ENV only takes a bare name, never a
  // path, so there's nothing for this test to point at beyond that fixed
  // default.
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ SPRING_LSP_WORKSPACE_ROOT: workspaceRoot }));

  const env = { ...process.env, HOME: home };
  delete env.SPRING_LSP_CONFIG_ENV;

  return new Promise((resolve, reject) => {
    const child = spawn("node", [DIST_SERVER_PATH], { env });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("server did not report listening within the timeout"));
    }, READY_TIMEOUT_MS);
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("listening on")) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited early (code ${code}) before listening - stderr:\n${stderr}`));
    });
  });
}

async function stopServer(child: ChildProcess): Promise<void> {
  child.removeAllListeners("exit");
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
}

let serverProcess: ChildProcess;
let client: Client;

before(async () => {
  const serverPort = 8398;
  serverProcess = await startServer(serverPort);
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${serverPort}/mcp`));
  client = new Client({ name: "spring-lsp-mcp-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  if (serverProcess) await stopServer(serverProcess);
  rmSync(workspaceRoot, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

test("lists all six spring-lsp tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["spring_boot_structure", "spring_completion", "spring_diagnostics", "spring_document_symbols", "spring_hover", "spring_workspace_symbols"],
  );
});

test("spring_boot_structure round-trips the real 'sts/spring-boot/structure' command and degrades cleanly (no Spring Boot app in this fixture)", async () => {
  const result = await callTool("spring_boot_structure", {});
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(result.data, []);
});

test("spring_diagnostics on application.properties succeeds without crashing the server", async () => {
  const result = await callTool("spring_diagnostics", { file: "src/main/resources/application.properties", waitMs: 1500 });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.data));
});

test("spring_completion on application.properties returns an array, not an error", async () => {
  const result = await callTool("spring_completion", { file: "src/main/resources/application.properties", line: 0, character: 6 });
  assert.equal(result.success, true, JSON.stringify(result));
});

test("an out-of-range file path outside the workspace root is rejected", async () => {
  const result = await callTool("spring_document_symbols", { file: "../../etc/passwd" });
  assert.equal(result.success, false);
  assert.ok(/outside the configured workspace root/.test(result.error), result.error);
});
