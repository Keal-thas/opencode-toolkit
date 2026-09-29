// Verifies the official @playwright/mcp package (not our own code) actually
// installs and behaves as documented, since deploy/opencode.json.example
// (once wired in) + mcp-servers/playwright/README.md describe it sight-unseen
// from its own README - see that README for the full design discussion
// (browser selection, permission split, launch flags).
//
// Spawns the real installed package's own bin (`playwright-mcp`, globally
// installed in docker/Dockerfile alongside a real headless Chromium - see
// its comment there), and drives it with a real @modelcontextprotocol/sdk
// Client against a locally-served fixture page - no mocking of the server
// itself, no dependency on external network reachability at test time.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));

let mcpClient;
let transport;
let httpServer;
let fixtureUrl;

before(async () => {
  const html = await readFile(join(here, "fixture.html"), "utf8");
  httpServer = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  fixtureUrl = `http://127.0.0.1:${port}/`;

  transport = new StdioClientTransport({
    command: "playwright-mcp",
    args: [
      "--headless",
      "--isolated",
      "--browser", "chromium",
      "--caps", "core,tabs,config,network,storage,devtools,vision,pdf,testing",
      "--image-responses", "omit",
    ],
    // StdioClientTransport does NOT inherit the parent process's
    // environment by default (confirmed live - PLAYWRIGHT_BROWSERS_PATH
    // was visibly set in the shell but the spawned playwright-mcp still
    // fell back to the default ~/.cache/ms-playwright, empty in this
    // image), so it has to be passed explicitly - same gotcha
    // redis.test.mjs's env already works around.
    env: process.env,
  });
  mcpClient = new Client({ name: "opencode-toolkit-test", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(transport);
});

after(async () => {
  await mcpClient?.close();
  await new Promise((resolve) => httpServer?.close(resolve));
});

async function callTool(name, args) {
  const result = await mcpClient.callTool({ name, arguments: args });
  const text = result.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
  assert.equal(result.isError ?? false, false, `${name} returned an error: ${text}`);
  return text;
}

test("lists a tool surface matching mcp-servers/playwright/README.md's documented read/write split", async () => {
  const { tools } = await mcpClient.listTools();
  const names = tools.map((t) => t.name);

  // Spot-check a handful from each side of the README's allow/ask split -
  // catches drift (a renamed or removed tool) rather than assuming the
  // README's tool names still match the real package.
  for (const readOnly of ["browser_snapshot", "browser_take_screenshot", "browser_console_messages", "browser_find"]) {
    assert.ok(names.includes(readOnly), `expected read-only tool ${readOnly}, got: ${names.join(", ")}`);
  }
  for (const writeTool of ["browser_navigate", "browser_click", "browser_type", "browser_evaluate"]) {
    assert.ok(names.includes(writeTool), `expected write tool ${writeTool}, got: ${names.join(", ")}`);
  }
  assert.ok(tools.length > 50, `expected the official package's broad (~90-tool) surface, got ${tools.length}`);
});

test("navigates to a real local page and snapshots its actual content", async () => {
  await callTool("browser_navigate", { url: fixtureUrl });
  const snapshot = await callTool("browser_snapshot", {});
  assert.match(snapshot, /Playwright MCP smoke test/);
  assert.match(snapshot, /idle/);
});

test("click on a real element changes real page state, not just reports success", async () => {
  await callTool("browser_navigate", { url: fixtureUrl });

  await callTool("browser_click", { target: "#btn", element: "the 'Click me' button" });

  const snapshot = await callTool("browser_snapshot", {});
  assert.match(snapshot, /clicked/);

  // Confirm independently of the click tool's own report, via evaluate
  // reading the live DOM - not just trusting the snapshot text matched.
  const evaluated = await callTool("browser_evaluate", {
    function: "() => document.getElementById('status').textContent",
  });
  assert.match(evaluated, /clicked/);
});

test("console_messages captures a real console.log from the page, triggered by the click above", async () => {
  const messages = await callTool("browser_console_messages", { all: true });
  assert.match(messages, /button-clicked/);
});

test("navigating to a page not on the allowed origin is rejected when --allowed-origins is set", async () => {
  // A second, independent client with a restrictive --allowed-origins, to
  // verify that flag actually does something against a real navigation -
  // not just documented, observed. Deliberately not the shared mcpClient
  // above, since this flag is process-startup-only (see the README's
  // "no runtime hot-switch" note - the same applies to any CLI flag, not
  // just --browser).
  const restrictedTransport = new StdioClientTransport({
    command: "playwright-mcp",
    args: [
      "--headless",
      "--isolated",
      "--browser", "chromium",
      "--allowed-origins", "http://example.invalid",
    ],
    env: process.env,
  });
  const restrictedClient = new Client({ name: "opencode-toolkit-test-restricted", version: "1.0.0" }, { capabilities: {} });
  await restrictedClient.connect(restrictedTransport);
  try {
    const result = await restrictedClient.callTool({ name: "browser_navigate", arguments: { url: fixtureUrl } });
    const text = result.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
    // Confirmed by observation, not assumed from the README: --allowed-origins
    // blocks the navigation itself (the tool call comes back as an error /
    // blocked-origin message), matching the README's caveat that this is a
    // request-level allowlist, not a network-level sandbox.
    assert.ok(result.isError || /blocked|not allowed|ERR_BLOCKED/i.test(text), `expected the disallowed navigation to be blocked, got: ${text}`);
  } finally {
    await restrictedClient.close();
  }
});
