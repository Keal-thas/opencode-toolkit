// Verifies the official @modelcontextprotocol/server-memory package (not
// our own code) actually installs and behaves as documented, since
// deploy/opencode.json.example + SETUP.md step 8 wire it in sight-unseen
// from its README - see mcp-servers/memory/README.md.
//
// Spawns the real installed package over stdio, the same way opencode
// itself starts a `type: "local"` MCP server (see
// docs/opencode-docs-reference/mcp-servers.mdx), and drives it with a real
// @modelcontextprotocol/sdk Client - no mocking of the server itself.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
// Resolved directly rather than via the `mcp-server-memory` bin shim -
// same reasoning as mcp-servers/oracle's test spawning `node server.js` directly:
// one less layer of indirection to go wrong.
const serverEntry = join(here, "node_modules", "@modelcontextprotocol", "server-memory", "dist", "index.js");

let client;
let transport;
let workDir;
let memoryFilePath;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mcp-memory-test-"));
  memoryFilePath = join(workDir, "memory.jsonl");

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, MEMORY_FILE_PATH: memoryFilePath },
  });
  client = new Client({ name: "opencode-toolkit-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await rm(workDir, { recursive: true, force: true });
});

test("lists the tools deploy/system-prompt.txt's Memory section tells the model to use", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "add_observations",
    "create_entities",
    "create_relations",
    "delete_entities",
    "delete_observations",
    "delete_relations",
    "open_nodes",
    "read_graph",
    "search_nodes",
  ]);
});

test("create_entities -> search_nodes round-trips, and MEMORY_FILE_PATH is actually written to disk", async () => {
  await client.callTool({
    name: "create_entities",
    arguments: {
      entities: [
        {
          name: "Franco",
          entityType: "person",
          observations: ["Prefers short chat replies with detail pushed to a file"],
        },
      ],
    },
  });

  const found = await client.callTool({ name: "search_nodes", arguments: { query: "short chat replies" } });
  const foundText = found.content?.map((c) => c.text).join("\n") ?? "";
  assert.match(foundText, /Franco/, "search_nodes should find the entity by an observation substring");

  // Not the package's own in-memory state - the actual file SETUP.md step 8
  // points MEMORY_FILE_PATH at, since that's the thing that has to survive
  // across opencode restarts on the real target machine.
  const onDisk = await readFile(memoryFilePath, "utf-8");
  assert.match(onDisk, /Franco/, "MEMORY_FILE_PATH should hold the persisted entity, not just an in-memory copy");
});

test("read_graph reflects deletions, not just a snapshot from before them", async () => {
  await client.callTool({ name: "delete_entities", arguments: { entityNames: ["Franco"] } });
  const graph = await client.callTool({ name: "read_graph", arguments: {} });
  const graphText = graph.content?.map((c) => c.text).join("\n") ?? "";
  assert.doesNotMatch(graphText, /Franco/, "deleted entity should be gone from a fresh read_graph");
});
