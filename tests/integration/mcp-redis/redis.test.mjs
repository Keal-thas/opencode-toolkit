// Verifies the official redis-mcp-server PyPI package (not our own code)
// actually installs and behaves as documented, since deploy/opencode.json.example
// + SETUP.md wire it in sight-unseen from its README - see
// docs/feature-points/20-redis-mcp-server.md.
//
// Spawns the real package via `uvx`, the same way opencode itself starts a
// `type: "local"` MCP server (see docs/opencode-docs-reference/mcp-servers.mdx),
// and drives it with a real @modelcontextprotocol/sdk Client - no mocking of
// the server itself. Connects as the sandbox's ACL-restricted `readonlyuser`
// (see docker/redis.conf), the same account a real deployment's
// mcp-servers/redis/README.md recommends.
//
// --host/--port are passed as CLI args, not REDIS_HOST/REDIS_PORT env vars -
// a confirmed bug in the installed package silently discards those two env
// vars in favor of Click's own hardcoded defaults (127.0.0.1:6379). See
// mcp-servers/redis/README.md's "Wired as type: local" section for the full
// explanation - this isn't a style choice, plain env vars for host/port
// don't work.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createClient } from "redis";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = process.env.REDIS_PORT ?? "6379";

let mcpClient;
let transport;
// A second, independent connection as the sandbox's unrestricted default
// user (see docker/redis.conf) - seeds/verifies data out-of-band, so tests
// aren't just trusting the tool under test's own report of what happened
// (same reasoning as memory.test.mjs reading MEMORY_FILE_PATH directly).
let seedClient;

before(async () => {
  seedClient = createClient({ socket: { host: REDIS_HOST, port: Number(REDIS_PORT) } });
  await seedClient.connect();

  transport = new StdioClientTransport({
    command: "uvx",
    args: ["--from", "redis-mcp-server@latest", "redis-mcp-server", "--host", REDIS_HOST, "--port", REDIS_PORT],
    env: { ...process.env, REDIS_USERNAME: "readonlyuser", REDIS_PWD: "readonlypass" },
  });
  mcpClient = new Client({ name: "opencode-toolkit-test", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(transport);
});

after(async () => {
  await mcpClient?.close();
  await seedClient?.quit();
});

async function callTool(name, args) {
  const result = await mcpClient.callTool({ name, arguments: args });
  return result.content?.map((c) => c.text).join("\n") ?? "";
}

test("lists the official package's full tool surface, including get/set", async () => {
  const { tools } = await mcpClient.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("get"), "expected a get tool");
  assert.ok(names.includes("set"), "expected a set tool");
  assert.ok(tools.length > 20, `expected the official package's broad tool surface, got ${tools.length} tools`);
});

test("get retrieves a value seeded independently of the tool under test", async () => {
  const key = `probe-${Date.now()}`;
  await seedClient.set(key, "hello-from-seed");
  try {
    const text = await callTool("get", { key });
    assert.match(text, /hello-from-seed/);
  } finally {
    await seedClient.del(key);
  }
});

test("the readonlyuser account rejects a write, cleanly - not a crash", async () => {
  const key = `probe-write-${Date.now()}`;
  const text = await callTool("set", { key, value: "should not be allowed" });
  assert.match(text, /no permissions/i);

  // Confirm it actually didn't write, via the independent seed connection -
  // not just that the tool's own text claimed it was denied.
  const exists = await seedClient.exists(key);
  assert.equal(exists, 0);
});

test("get on a nonexistent key returns a clean message, not a crash", async () => {
  const text = await callTool("get", { key: `definitely-missing-${Date.now()}` });
  assert.match(text, /does not exist/);
});
