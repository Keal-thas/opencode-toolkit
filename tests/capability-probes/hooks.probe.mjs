#!/usr/bin/env node
// Capability probe, not a pass/fail test - see tests/README.md's "Capability
// probes vs. tests" section for why this whole directory is kept out of
// tests/run-all.sh's gate.
//
// Answers three concrete questions about opencode's own plugin-hook runtime
// that our plugins (llm-review-gate/, hook-logger/) depend on but that a
// fake-client unit test can't observe:
//
//   1. What does opencode actually send the model on a real turn (system
//      prompt, tool defs, message history)? Dumped verbatim - there's no
//      "expected" shape to assert against, just evidence to read.
//   2. Which Hooks-interface keys does the runtime actually invoke on a live
//      turn, vs. which are silently dead? (llm-review-gate.ts's header
//      comment claims `permission.ask` is typed but never dispatched - this
//      prints the full observed set so that's checked directly, and so a
//      future opencode upgrade that changes the set is visible here.)
//   3. Does a plugin hook throwing in tool.execute.before actually prevent
//      the tool from running, end-to-end through a real session - not just
//      that the hook function itself throws in isolation. Also checks the
//      analogous mutation case: does experimental.chat.system.transform's
//      output actually reach the model, or is it silently ignored too?
//
// Also dumps every tool's real description/parameters schema as observed via
// tool.definition, into evidence - tools.probe.mjs relies on this inventory
// having been eyeballed once for the tools it drives.
//
// Run manually inside the docker/ sandbox (never against the host node/opencode
// install, see CLAUDE.md):
//   docker/dev.sh run --rm opencode-dev bash -c \
//     'cd tests/capability-probes && npm install --no-audit --no-fund && node hooks.probe.mjs'
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setupProbeEnv, saveEvidence } from "./lib/harness.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(SCRIPT_DIR, "..", "..", ".local", "capability-probes", "hooks");
const SYSTEM_MARKER = "PROBE-SYSTEM-MARKER-4f8a";

process.env.PROBE_BLOCK_TOOL = "bash";
process.env.PROBE_SYSTEM_MARKER = SYSTEM_MARKER;

const env = await setupProbeEnv({
  pluginFiles: { "probe-hook.js": await readFile(join(SCRIPT_DIR, "probe-hook.js"), "utf8") },
  config: { permission: { bash: "allow" } },
});

try {
  env.provider.setPlan([
    { toolCall: { id: "call_probe_1", name: "bash", args: { command: "echo hello-from-probe" } } },
    { text: "probe turn finished" },
  ]);

  const created = await env.client.session.create({ body: { title: "hooks.verify" } });
  const sessionID = created.data.id;
  await env.client.session.prompt({
    path: { id: sessionID },
    body: { parts: [{ type: "text", text: "run a shell command" }] },
  });

  const allParts = await env.transcript(sessionID);
  const toolPart = allParts.find((p) => p.type === "tool" && p.tool === "bash");

  console.log("\n=== Q3a: does tool.execute.before throwing actually block the tool call? ===");
  if (!toolPart) {
    console.log("No bash ToolPart found anywhere in the session transcript - inconclusive.");
  } else {
    console.log(`bash ToolPart state: ${JSON.stringify(toolPart.state)}`);
    console.log(
      toolPart.state.status === "error" && toolPart.state.error?.includes("blocked-by-probe")
        ? "CONFIRMED: the thrown error became the tool's real execution error - the command never ran."
        : "NOT CONFIRMED: tool did not end in the expected blocked-error state - see raw state above.",
    );
  }

  console.log("\n=== Q3b: does experimental.chat.system.transform's output mutation actually reach the model? ===");
  const lastRequest = env.provider.capturedRequests.at(-1);
  // opencode.system is an array, and each entry becomes its OWN separate
  // system-role message rather than one joined string - checking only the
  // first system message here would silently miss every later one.
  const systemMessages = lastRequest?.messages?.filter((m) => m.role === "system") ?? [];
  console.log(`(${systemMessages.length} separate system-role messages in the request - one per output.system array entry)`);
  console.log(
    systemMessages.some((m) => m.content?.includes(SYSTEM_MARKER))
      ? "CONFIRMED: the marker this hook pushed onto output.system shows up verbatim as its own system message in the real request sent to the model."
      : "NOT CONFIRMED: marker missing from every system message actually sent - see requests.json in evidence.",
  );

  console.log("\n=== Q2: which Hooks-interface keys actually fired on this real run? ===");
  const firedHooks = await env.firedHooks();
  console.log("Fired:", firedHooks.join(", ") || "(none)");
  const registeredInProbe = [
    "event", "chat.message", "chat.params", "chat.headers", "permission.ask",
    "command.execute.before", "tool.definition", "tool.execute.before", "tool.execute.after",
    "experimental.chat.system.transform",
  ];
  const neverFired = registeredInProbe.filter((h) => !firedHooks.includes(h));
  console.log("Registered but never fired:", neverFired.join(", ") || "(none)");
  console.log(
    "Of those: tool.execute.after is expected - the block happened in tool.execute.before, nothing ran " +
    "afterward. command.execute.before is expected - this scenario never runs a slash command. permission.ask is " +
    "the interesting one: this run uses bash:\"allow\" (needed so Q3a isn't gated behind an interactive prompt " +
    "this headless probe can't answer), so its absence here is necessary but not sufficient proof it's dead - " +
    "see llm-review-gate.ts's header comment for the stronger claim (verified against opencode's own server " +
    "source directly), and permissions.probe.mjs for the \"ask\" tier attempt.",
  );

  const toolDefs = (await env.readHookLog("tool.definition")).map((e) => ({
    toolID: e.input?.toolID,
    description: e.output?.description,
    parameters: e.output?.parameters,
  }));
  const uniqueToolIDs = [...new Set(toolDefs.map((t) => t.toolID))];
  console.log(
    `\nDiscovered ${uniqueToolIDs.length} unique tool definitions (${toolDefs.length} total firings - once per ` +
    `request round, so this repeats per round) - tool IDs:`,
    uniqueToolIDs.join(", "),
  );

  console.log(`\n=== Q1: raw request bodies opencode sent to the model (${env.provider.capturedRequests.length} captured) ===`);
  const evidence = { "requests.json": env.provider.capturedRequests, "tool-definitions.json": toolDefs };
  for (const name of firedHooks) evidence[`${name}.jsonl`] = await readFile(join(env.logDir, `${name}.jsonl`), "utf8");
  await saveEvidence(EVIDENCE_DIR, evidence);
  console.log(`Written to ${EVIDENCE_DIR}/ (requests.json, tool-definitions.json, per-hook *.jsonl)`);
} finally {
  await env.cleanup();
}
