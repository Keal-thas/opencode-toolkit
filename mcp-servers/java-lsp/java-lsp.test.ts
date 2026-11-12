// Requires a JDK 21+ `java` on PATH (and `python3`/`python`/`py -3` on Windows)
// to launch the vendored jdtls (see README's "JDK version" section). Not mockable: LSP is a genuinely
// stateful protocol, and the whole point is talking to a real jdtls process.
//
// Not yet wired into tests/run-in-container.sh / the docker/ sandbox - no JDK
// in that image (see mcp-servers/TODO.md). Run directly on a machine with a
// JDK 21+: `cd mcp-servers/java-lsp && npm install && npm run
// build && npm test`.
//
// server.ts is config-file-driven (see README's Configuration section, and
// oracle.test.ts for the same fake-$HOME pattern this test reuses) - spawns
// the compiled dist/server.js with its own fake $HOME so it never shares
// config with a real server running in the same environment.
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

// The server launches its own vendored jdtls, so all the test needs on the
// machine is a JDK 21+ `java` for that launcher to find.
try {
  execSync("java -version", { stdio: "ignore" });
} catch {
  throw new Error("java not found on PATH - jdtls needs a JDK 21+ runtime to launch. See README.md's 'JDK version' section.");
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

// A small multi-file fixture for the cross-file tools: an interface, two
// implementations, a caller, and a file that doesn't compile.
const fixtures: Record<string, string[]> = {
  Greeter: ["package com.example;", "", "public interface Greeter {", "    String greet(String name);", "}", ""],
  EnglishGreeter: [
    "package com.example;",
    "",
    "public class EnglishGreeter implements Greeter {",
    "    public String greet(String name) { return \"Hello, \" + name; }",
    "}",
    "",
  ],
  SpanishGreeter: [
    "package com.example;",
    "",
    "public class SpanishGreeter implements Greeter {",
    "    public String greet(String name) { return \"Hola, \" + name; }",
    "}",
    "",
  ],
  Caller: [
    "package com.example;",
    "",
    "public class Caller {",
    "    public String run(Greeter g) {",
    '        return g.greet("x");',
    "    }",
    "}",
    "",
  ],
  Broken: [
    "package com.example;",
    "",
    "public class Broken {",
    "    public int f() {",
    '        return "not an int";',
    "    }",
    "    void g() { undefinedCall(); }",
    "}",
    "",
  ],
};
for (const [name, lines] of Object.entries(fixtures)) writeFileSync(join(srcDir, `${name}.java`), lines.join("\n"));
const fixtureFile = (name: string) => `src/main/java/com/example/${name}.java`;

function startServer(port: number): Promise<ChildProcess> {
  const home = mkdtempSync(join(tmpdir(), "java-lsp-mcp-test-home-"));
  const configDir = join(home, ".config", "kealthas-dev", "opencode-mcp-java-lsp");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "server.json"), JSON.stringify({ JAVA_LSP_MCP_PORT: port }));

  // Written straight to the default config.json location (not pointed at via
  // an env var) - JAVA_LSP_CONFIG_ENV only takes a bare name, never a path,
  // so there's nothing for this test to point at beyond that fixed default.
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ JAVA_LSP_WORKSPACE_ROOT: workspaceRoot, JDTLS_DATA_DIR: dataDir }),
  );

  // os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.JAVA_LSP_CONFIG_ENV;

  return new Promise((resolve, reject) => {
    const child = spawn("node", [DIST_SERVER_PATH], { env });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("server did not report listening within the timeout"));
    }, READY_TIMEOUT_MS);

    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
      serverStderr += chunk;
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

let serverStderr = ""; // everything the server logged, to explain a failing assertion
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
  // Retries: on Windows a just-exited process can hold its files for a moment (EBUSY).
  const rmOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };
  rmSync(workspaceRoot, rmOptions);
  rmSync(dataDir, rmOptions);
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

test("java_definition jumps from a call site to the interface method in another file", async () => {
  // Caller.java line 4: `        return g.greet("x");` - character 18 is inside `greet`.
  const result = await callTool("java_definition", { file: fixtureFile("Caller"), line: 4, character: 18 });
  assert.equal(result.success, true);
  const text = JSON.stringify(result.data);
  assert.ok(text.includes("Greeter.java"), `expected a location in Greeter.java, got ${text}`);
  assert.ok(!text.includes("Caller.java"), `definition should not point back at the call site, got ${text}`);
});

test("java_implementation finds both concrete implementations of an interface method", async () => {
  // Greeter.java line 3: `    String greet(String name);` - character 13 is inside `greet`.
  const result = await callTool("java_implementation", { file: fixtureFile("Greeter"), line: 3, character: 13 });
  assert.equal(result.success, true);
  const text = JSON.stringify(result.data);
  assert.equal(result.data.length, 2, `expected two implementations, got ${text}`);
  assert.ok(text.includes("EnglishGreeter.java") && text.includes("SpanishGreeter.java"), text);
});

test("java_diagnostics returns the real compile errors for a broken file and nothing for a clean one", async () => {
  // Without a Maven/Gradle file jdtls can't tell src/main/java is a source root, so it flags every
  // file with a package-mismatch diagnostic. That's a fixture artifact, not what's under test here.
  const real = (data: any[]) => data.filter((d) => !/declared package/.test(d.message));

  const broken = await callTool("java_diagnostics", { file: fixtureFile("Broken"), waitMs: 8000 });
  assert.equal(broken.success, true);
  const errors = real(broken.data).filter((d: any) => d.severity === 1);
  const diagnosticsLog = serverStderr.split("\n").filter((l) => l.includes("[jdtls:diagnostics]")).join("\n");
  assert.ok(errors.length >= 2, `expected the type mismatch and the undefined method, got ${JSON.stringify(broken.data)}\n${diagnosticsLog}`);

  const clean = await callTool("java_diagnostics", { file: fixtureFile("Greeter"), waitMs: 8000 });
  assert.equal(clean.success, true);
  assert.deepEqual(real(clean.data), []);
});
