// Requires a real `jdtls` on PATH (e.g. `brew install jdtls` on macOS, or
// however the target machine provides it - see README.md's "JDK version"
// section) and a JDK 21+ runtime for jdtls to launch with. Not something
// this test can mock: LSP is a genuinely stateful protocol (project
// indexing, incremental document sync), and the whole point of this
// package is that it talks to a real jdtls process - see
// mcp-servers/loki/loki.test.ts for the same reasoning applied to a different
// real backend.
//
// Not yet wired into tests/run-in-container.sh / the docker/ sandbox - the
// sandbox's image (docker/Dockerfile, `FROM node:22-bookworm`) has no JDK
// or jdtls installed, and adding a jdtls download to the image wasn't done
// here (see mcp-servers/TODO.md). Run this directly on a machine with jdtls
// installed: `cd mcp-servers/java-lsp && npm install && npm run build && npm test`.
//
// server.ts reads its workspace/data-dir config from a JSON file pointed at
// by JAVA_LSP_CONFIG_FILE and its port from a fixed-path server.json under
// $HOME/.config/kealthas-dev/opencode-mcp-java-lsp/ (see README.md's
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
const READY_TIMEOUT_MS = 20_000;

try {
  execSync("jdtls --help", { stdio: "ignore" });
} catch {
  throw new Error(
    "jdtls not found on PATH - this test needs a real jdtls install (e.g. `brew install jdtls` on " +
      "macOS), not a mock. See README.md's 'JDK version' section.",
  );
}

// A fresh sample project per run, under the OS temp dir - not committed
// fixtures, so this test doesn't depend on anything checked into the repo
// beyond this file itself.
const workspaceRoot = mkdtempSync(join(tmpdir(), "java-lsp-mcp-test-"));
const dataDir = mkdtempSync(join(tmpdir(), "java-lsp-mcp-test-data-"));
const srcDir = join(workspaceRoot, "src/main/java/com/example");
mkdirSync(srcDir, { recursive: true });
const javaFile = join(srcDir, "Hello.java");
writeFileSync(
  javaFile,
  [
    "package com.example;",
    "",
    "public class Hello {",
    "    public String greet(String name) {",
    '        return "Hello, " + name;',
    "    }",
    "",
    "    public static void main(String[] args) {",
    "        Hello h = new Hello();",
    '        System.out.println(h.greet("world"));',
    "    }",
    "}",
    "",
  ].join("\n"),
);
const relativeFile = "src/main/java/com/example/Hello.java";

function startServer(port: number): Promise<ChildProcess> {
  const home = mkdtempSync(join(tmpdir(), "java-lsp-mcp-test-home-"));
  const configDir = join(home, ".config", "kealthas-dev", "opencode-mcp-java-lsp");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "server.json"), JSON.stringify({ JAVA_LSP_MCP_PORT: port }));

  const configPath = join(home, "java-lsp-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ JAVA_LSP_WORKSPACE_ROOT: workspaceRoot, JDTLS_DATA_DIR: dataDir }),
  );

  return new Promise((resolve, reject) => {
    const child = spawn("node", [DIST_SERVER_PATH], {
      env: { ...process.env, HOME: home, JAVA_LSP_CONFIG_FILE: configPath },
    });

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
  const serverPort = 8298;
  serverProcess = await startServer(serverPort);
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${serverPort}/mcp`));
  client = new Client({ name: "java-lsp-mcp-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  if (serverProcess) await stopServer(serverProcess);
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

test("lists all seven java-lsp tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "java_definition",
      "java_diagnostics",
      "java_document_symbols",
      "java_hover",
      "java_implementation",
      "java_references",
      "java_workspace_symbols",
    ],
  );
});

test("java_document_symbols finds the real class and both methods, structurally", async () => {
  const result = await callTool("java_document_symbols", { file: relativeFile });
  assert.equal(result.success, true);
  const names = result.data.map((s: any) => s.name).sort();
  assert.deepEqual(names, ["Hello", "greet(String)", "main(String[])"]);
});

test("java_hover resolves the real return type of greet(), not just its name", async () => {
  const result = await callTool("java_hover", { file: relativeFile, line: 3, character: 18 });
  assert.equal(result.success, true);
  const text = JSON.stringify(result.data);
  assert.ok(text.includes("String Hello.greet(String name)"), `expected resolved signature, got ${text}`);
});

test("java_references finds the declaration and the one real call site, not name-text matches", async () => {
  const result = await callTool("java_references", { file: relativeFile, line: 3, character: 18 });
  assert.equal(result.success, true);
  assert.equal(result.data.length, 2, `expected declaration + 1 call site, got ${JSON.stringify(result.data)}`);
});

test("java_workspace_symbols finds Hello by a fuzzy name query", async () => {
  const result = await callTool("java_workspace_symbols", { query: "Hello" });
  assert.equal(result.success, true);
  assert.ok(result.data.some((s: any) => s.name === "Hello"), `expected Hello in ${JSON.stringify(result.data)}`);
});

test("an out-of-range file path outside the workspace root is rejected", async () => {
  const result = await callTool("java_document_symbols", { file: "../../etc/passwd" });
  assert.equal(result.success, false);
  assert.ok(/outside the configured workspace root/.test(result.error), result.error);
});
