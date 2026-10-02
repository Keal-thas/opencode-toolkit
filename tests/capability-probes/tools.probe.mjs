#!/usr/bin/env node
// Capability probe, not a pass/fail test - see tests/capability-probes/README.md.
//
// Drives opencode's own built-in tools (the ones a coding agent actually uses
// day to day: write, read, edit, glob, grep, webfetch, todowrite) through a
// real session, each via a fake-model tool_calls request (see lib/harness.mjs)
// using the exact argument shapes discovered live by hooks.probe.mjs's
// tool.definition dump (tool-definitions.json in its evidence dir) - not
// guessed from memory. For each tool: what does its ToolPart end up looking
// like (completed vs. error, output shape), and for the filesystem ones, does
// the real file on disk actually end up matching what opencode reported back?
//
// Run manually inside the docker/ sandbox:
//   docker/dev.sh run --rm opencode-dev bash -c \
//     'cd tests/capability-probes && npm install --no-audit --no-fund && node tools.probe.mjs'
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setupProbeEnv, saveEvidence } from "./lib/harness.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(SCRIPT_DIR, "..", "..", ".local", "capability-probes", "tools");

// external_directory matters here specifically because the sandbox target
// lives under os.tmpdir(), outside the project working directory opencode
// was started in (tests/capability-probes/) - without this, read/edit/glob/
// grep on that path silently sit at the default "ask" tier with no TUI to
// answer it, hanging forever rather than erroring. Found live: the first cut
// of this probe hung on every filesystem tool until this was added.
const env = await setupProbeEnv({
  config: { permission: { bash: "allow", read: "allow", edit: "allow", webfetch: "allow", external_directory: "allow" } },
});

const sandboxDir = await mkdtemp(join(tmpdir(), "tools-verify-target-"));
const targetFile = join(sandboxDir, "probe-target.txt");

const results = {};

async function runToolCase(name, toolCall) {
  process.stderr.write(`[start] ${name}\n`);
  env.provider.setPlan([{ toolCall }, { text: `${name} probe turn finished` }]);
  const created = await env.client.session.create({ body: { title: `tools.verify:${name}` } });
  const sessionID = created.data.id;
  try {
    await Promise.race([
      env.client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: `please use the ${toolCall.name} tool` }] },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("probe timeout after 20s")), 20_000)),
    ]);
  } catch (e) {
    process.stderr.write(`[timeout/error] ${name}: ${e.message}\n`);
    results[name] = { status: "PROBE_ERROR", detail: e.message };
    return null;
  }
  const parts = await env.transcript(sessionID);
  const toolPart = parts.find((p) => p.type === "tool" && p.tool === toolCall.name);
  results[name] = toolPart
    ? { status: toolPart.state.status, detail: toolPart.state.output ?? toolPart.state.error ?? null }
    : { status: "NO_TOOL_PART_FOUND", detail: null };
  process.stderr.write(`[done] ${name}: ${results[name].status}\n`);
  return toolPart;
}

try {
  await runToolCase("write", {
    id: "call_write",
    name: "write",
    args: { filePath: targetFile, content: "hello from tools.verify\nline2\n" },
  });
  await runToolCase("read", { id: "call_read", name: "read", args: { filePath: targetFile } });
  await runToolCase("edit", {
    id: "call_edit",
    name: "edit",
    args: { filePath: targetFile, oldString: "hello from tools.verify", newString: "EDITED by tools.verify" },
  });
  await runToolCase("glob", { id: "call_glob", name: "glob", args: { pattern: "*.txt", path: sandboxDir } });
  await runToolCase("grep", { id: "call_grep", name: "grep", args: { pattern: "EDITED", path: sandboxDir } });
  await runToolCase("webfetch", {
    id: "call_webfetch",
    name: "webfetch",
    args: { url: "http://127.0.0.1:1/definitely-unreachable", format: "text" },
  });
  await runToolCase("todowrite", {
    id: "call_todo",
    name: "todowrite",
    args: { todos: [{ content: "probe todo", status: "pending", priority: "low" }] },
  });

  // Ground truth: what's actually on disk, independent of what opencode's
  // ToolPart claims happened.
  const actualFileContent = await readFile(targetFile, "utf8").catch((e) => `<error reading: ${e.message}>`);

  console.log("\n=== Per-tool ToolPart outcome ===");
  for (const [name, r] of Object.entries(results)) {
    console.log(`${name}: ${r.status}`);
  }

  console.log("\n=== Filesystem ground truth vs. what write+edit reported ===");
  console.log("Actual file content on disk:", JSON.stringify(actualFileContent));
  console.log(
    actualFileContent.includes("EDITED by tools.verify") && !actualFileContent.includes("hello from tools.verify")
      ? "CONFIRMED: write then edit landed on the real filesystem exactly as the ToolParts reported - not just claimed."
      : "NOT CONFIRMED: real file content doesn't match the edit that was supposedly applied - see evidence.",
  );

  await saveEvidence(EVIDENCE_DIR, {
    "results.json": results,
    "actual-file-content.txt": actualFileContent,
    "requests.json": env.provider.capturedRequests,
  });
  console.log(`\nFull per-tool ToolPart detail + raw requests written to ${EVIDENCE_DIR}/`);
} finally {
  await env.cleanup();
  await rm(sandboxDir, { recursive: true, force: true });
}
