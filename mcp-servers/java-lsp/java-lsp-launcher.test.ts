// Covers the "JDK on PATH is too old" setup: PATH's `java` is 8, a JDK 21 lives elsewhere, and
// KEALTHAS_JAVA_LSP_JDTLS_LAUNCHER_JAVA_EXECUTABLE in config.json points at it (README's "JDK version").
//
// The JDK 21 is stood in for by the machine's real `java` (which must be 21+, same requirement as
// java-lsp.test.ts), wrapped in a script that records each invocation so the test can prove jdtls was
// launched through the configured executable and not through PATH. The control case puts a fake JDK 8
// `java` first on PATH and leaves the setting out: that must fail, which shows the fake really wins on
// PATH and the positive case isn't passing by accident. The control needs a POSIX shell to write a
// `java` shim, so it is skipped on Windows; the positive case runs everywhere.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const DIST_SERVER_PATH = join(here, "dist", "server.js");
const isWindows = process.platform === "win32";
const PORT_WITH_LAUNCHER = 8299;
const PORT_WITHOUT_LAUNCHER = 8300;

// Forward slashes everywhere: they go into JSON config and onto a jdtls command line (see README, Configuration).
const slash = (p: string) => p.replaceAll("\\", "/");

const realJavaHome = /java\.home = (.+)/.exec(execSync("java -XshowSettings:property -version 2>&1", { encoding: "utf8" }))?.[1].trim();
assert.ok(realJavaHome, "could not determine java.home of the java on PATH");
const realJava = slash(join(realJavaHome, "bin", isWindows ? "java.exe" : "java"));

const scratch = mkdtempSync(join(tmpdir(), "java-lsp-launcher-test-"));
const workspaceRoot = join(scratch, "project");
const srcDir = join(workspaceRoot, "src/main/java/com/example");
mkdirSync(srcDir, { recursive: true });
writeFileSync(join(srcDir, "Hello.java"), "package com.example;\n\npublic class Hello {\n    public String greet() { return \"hi\"; }\n}\n");

// Records every call, then hands over to the real java.
const marker = slash(join(scratch, "launcher-calls.log"));
const wrapperDir = join(scratch, "jdk21-stand-in", "bin");
mkdirSync(wrapperDir, { recursive: true });
const wrapper = slash(join(wrapperDir, isWindows ? "java.cmd" : "java"));
if (isWindows) {
  writeFileSync(wrapper, `@echo off\r\necho %* >> "${marker}"\r\n"${realJava}" %*\r\n`);
} else {
  writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> "${marker}"\nexec "${realJava}" "$@"\n`);
  chmodSync(wrapper, 0o755);
}

// A `java` that claims to be JDK 8 and refuses to do anything else.
const jdk8ShimDir = join(scratch, "jdk8-on-path");
mkdirSync(jdk8ShimDir, { recursive: true });
if (!isWindows) {
  writeFileSync(join(jdk8ShimDir, "java"), '#!/bin/sh\necho \'openjdk version "1.8.0_402"\' >&2\nexit 1\n');
  chmodSync(join(jdk8ShimDir, "java"), 0o755);
}

const children: ChildProcess[] = [];
const clients: Client[] = [];

function startServer(port: number, config: Record<string, unknown>, path: string): Promise<ChildProcess> {
  const home = mkdtempSync(join(scratch, "home-"));
  const configDir = join(home, ".config", "kealthas-dev", "opencode-mcp-java-lsp");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "server.json"), JSON.stringify({ JAVA_LSP_MCP_PORT: port }));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ JAVA_LSP_WORKSPACE_ROOT: slash(workspaceRoot), JDTLS_DATA_DIR: slash(mkdtempSync(join(scratch, "data-"))), ...config }),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PATH: path };
  delete env.JAVA_LSP_CONFIG_ENV;
  delete env.JAVA_HOME; // jdtls would otherwise fall back to it, hiding which setting did the work

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_SERVER_PATH], { env });
    children.push(child);
    const timeout = setTimeout(() => reject(new Error("server did not report listening in time")), 20_000);
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
      reject(new Error(`server exited early (code ${code}):\n${stderr}`));
    });
  });
}

async function connect(port: number): Promise<Client> {
  const client = new Client({ name: "java-lsp-launcher-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
  clients.push(client);
  return client;
}

async function documentSymbols(client: Client): Promise<any> {
  const result = await client.callTool({ name: "java_document_symbols", arguments: { file: "src/main/java/com/example/Hello.java" } });
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const child of children) {
    child.removeAllListeners("exit");
    child.kill();
    await new Promise((resolve) => (child.exitCode === null ? child.once("exit", resolve) : resolve(null)));
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("with the launcher JDK set in config.json, jdtls is started through it", async () => {
  // Windows has no way to fake a JDK 8 `java` here, so there PATH stays as is; the marker file still shows who launched jdtls.
  const path = isWindows ? process.env.PATH! : `${jdk8ShimDir}${delimiter}${process.env.PATH}`;
  await startServer(PORT_WITH_LAUNCHER, { KEALTHAS_JAVA_LSP_JDTLS_LAUNCHER_JAVA_EXECUTABLE: wrapper }, path);
  const result = await documentSymbols(await connect(PORT_WITH_LAUNCHER));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.ok(result.data.some((s: any) => s.name === "Hello"), JSON.stringify(result.data));

  assert.ok(existsSync(marker), "the configured java was never invoked - jdtls was launched some other way");
  const calls = readFileSync(marker, "utf8");
  assert.ok(/-version/.test(calls) && /equinox/i.test(calls), `expected the version probe and the jdtls launch in:\n${calls}`);
});

test(
  "without it, a JDK 8 first on PATH makes jdtls refuse to start",
  { skip: isWindows && "needs a POSIX shell to fake a JDK 8 `java`" },
  async () => {
    await startServer(PORT_WITHOUT_LAUNCHER, {}, `${jdk8ShimDir}${delimiter}${process.env.PATH}`);
    const result = await documentSymbols(await connect(PORT_WITHOUT_LAUNCHER));
    assert.equal(result.success, false, `expected a failure, got ${JSON.stringify(result).slice(0, 300)}`);
  },
);
