// Static checks on the config/docs that ship the system-prompt override.
// No opencode install needed - these just read files and parse JSON/markdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function extractJsonFences(markdown) {
  const fences = [];
  const re = /```json\n([\s\S]*?)\n[ \t]*```/g;
  let m;
  while ((m = re.exec(markdown))) fences.push(m[1]);
  return fences;
}

test("deploy/opencode.json.example is valid JSON wiring build/plan/general to system-prompt.txt", async () => {
  const raw = await readFile(join(repoRoot, "deploy", "opencode.json.example"), "utf-8");
  const config = JSON.parse(raw);
  for (const agent of ["build", "plan", "general"]) {
    assert.equal(config.agent?.[agent]?.prompt, "{file:./system-prompt.txt}", `agent.${agent}.prompt`);
  }
});

test("deploy/opencode.json.example wires the memory MCP server as a local, enabled-by-default stdio server", async () => {
  const raw = await readFile(join(repoRoot, "deploy", "opencode.json.example"), "utf-8");
  const config = JSON.parse(raw);
  assert.equal(config.mcp?.memory?.type, "local");
  assert.deepEqual(config.mcp?.memory?.command, ["mcp-server-memory"]);
  assert.equal(config.mcp?.memory?.enabled, true, "should ship enabled, same as oracle/loki/java-lsp/spring-lsp");
});

test("deploy/system-prompt.txt is non-empty and doesn't contain upstream's default identity paragraph", async () => {
  const custom = await readFile(join(repoRoot, "deploy", "system-prompt.txt"), "utf-8");
  assert.ok(custom.trim().length > 0, "system-prompt.txt should not be empty");
  // The upstream identity paragraph is the clearest signal the override
  // didn't actually take effect - our replacement must not contain it.
  assert.ok(!custom.includes("interactive CLI tool that helps users with software engineering tasks"));
});

test("deploy/models-dev-snapshot.json parses as JSON", async () => {
  const raw = await readFile(join(repoRoot, "deploy", "models-dev-snapshot.json"), "utf-8");
  assert.doesNotThrow(() => JSON.parse(raw));
});

test("SETUP.md's documented agent-merge JSON snippet matches deploy/opencode.json.example (no config drift)", async () => {
  const [setup, exampleRaw] = await Promise.all([
    readFile(join(repoRoot, "SETUP.md"), "utf-8"),
    readFile(join(repoRoot, "deploy", "opencode.json.example"), "utf-8"),
  ]);
  const example = JSON.parse(exampleRaw);

  const fences = extractJsonFences(setup);
  const agentFence = fences.find((f) => f.trim().startsWith('"agent"'));
  assert.ok(agentFence, "expected a fenced ```json block starting with \"agent\" in SETUP.md step 2");

  const documented = JSON.parse(`{${agentFence}}`);
  assert.deepEqual(documented.agent, example.agent);
});
