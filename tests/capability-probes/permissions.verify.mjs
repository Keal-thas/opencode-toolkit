#!/usr/bin/env node
// Capability probe, not a pass/fail test - see tests/capability-probes/README.md.
//
// Two questions about opencode's own permission-tier enforcement:
//
//   1. "deny" tier - does it actually short-circuit the tool call immediately
//      (no interactive prompt, no hang), and does that show up as a real
//      ToolPart error rather than the request just silently vanishing?
//   2. "ask" tier - can a headless client actually resolve one at all? This
//      needs subscribing to the raw SSE event stream for a `permission.updated`
//      event and replying via the client's `postSessionIdPermissionsPermissionId`
//      method (the same mechanism a real TUI uses under the hood) - there's no
//      documented higher-level wrapper for this, so it's driven directly
//      against the generated client. hooks.verify.mjs deliberately avoids this
//      tier entirely (risk of a headless run hanging forever with nothing to
//      answer an interactive prompt); this script takes that risk on its own,
//      bounded by a hard timeout so a failed race reports as a finding, not
//      a hung process.
//
// Each tier gets its own opencode server (permission tiers are fixed at
// server startup, not per-request), so this runs setupProbeEnv() twice.
//
// Run manually inside the docker/ sandbox:
//   docker/dev.sh run --rm opencode-dev bash -c \
//     'cd tests/capability-probes && npm install --no-audit --no-fund && node permissions.verify.mjs'
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setupProbeEnv, saveEvidence } from "./lib/harness.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(SCRIPT_DIR, "..", "..", ".local", "capability-probes", "permissions");

async function probeDenyTier() {
  const env = await setupProbeEnv({ config: { permission: { bash: "deny" } } });
  try {
    env.provider.setPlan([
      { toolCall: { id: "call_deny_1", name: "bash", args: { command: "echo should-never-run" } } },
      { text: "done" },
    ]);
    const created = await env.client.session.create({ body: { title: "permissions.verify:deny" } });
    const sessionID = created.data.id;
    const promptResult = await Promise.race([
      env.client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: "run a shell command" }] },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout after 20s - deny tier hung instead of short-circuiting")), 20_000)),
    ]);
    const parts = await env.transcript(sessionID);
    const bashPart = parts.find((p) => p.type === "tool" && p.tool === "bash");
    const invalidPart = parts.find((p) => p.type === "tool" && p.tool === "invalid");
    console.log("\n=== Q: does \"deny\" tier short-circuit immediately, with no interactive hang? ===");
    console.log("bash ToolPart:", bashPart ? JSON.stringify(bashPart.state) : "none found");
    console.log("invalid ToolPart:", invalidPart ? JSON.stringify(invalidPart.state) : "none found");
    console.log(
      invalidPart?.state.input?.error?.includes("unavailable tool")
        ? "CONFIRMED, but not the mechanism expected: \"deny\" removes the tool from the set advertised to the " +
          "model entirely (it's just missing from the tools list opencode sends), rather than letting the call " +
          "through and rejecting it at execution time the way tool.execute.before's throw does. Our fake model " +
          "still tried to call it anyway (it doesn't read the tools list), which is why this shows up as opencode's " +
          "own \"invalid tool\" handling rather than a bash-specific error."
        : "NOT CONFIRMED - neither the expected bash error nor the invalid-tool pattern showed up, see full transcript in evidence.",
    );
    return { bashPart: bashPart?.state ?? null, invalidPart: invalidPart?.state ?? null, fullTranscript: parts };
  } catch (e) {
    console.log("\n=== Q: does \"deny\" tier short-circuit immediately, with no interactive hang? ===");
    console.log("NOT CONFIRMED - timed out instead:", e.message);
    return { error: e.message };
  } finally {
    await env.cleanup();
  }
}

async function probeAskTier() {
  const env = await setupProbeEnv({ config: { permission: { bash: "ask" } } });
  try {
    env.provider.setPlan([
      { toolCall: { id: "call_ask_1", name: "bash", args: { command: "echo auto-approved" } } },
      { text: "done" },
    ]);
    const created = await env.client.session.create({ body: { title: "permissions.verify:ask" } });
    const sessionID = created.data.id;

    // Subscribe BEFORE issuing the prompt that will trigger the permission
    // request, so there's no window where the event could fire and be missed.
    const sub = await env.client.event.subscribe();
    let repliedPermission = null;
    const seenEventTypes = [];
    const permissionEventsRaw = [];
    const autoApprove = (async () => {
      for await (const evt of sub.stream) {
        seenEventTypes.push(evt.type);
        // The SDK's own generated types (EventPermissionUpdated) claim this
        // event is called "permission.updated" - the real server emits
        // "permission.asked" instead (confirmed live, matches the docs
        // mirror's plugins.mdx "Permission Events" list, not the .d.ts).
        // Logging every permission-prefixed event raw, not just the one this
        // filter expects, so a future SDK/server drift shows up in evidence
        // instead of silently timing out again.
        if (evt.type?.startsWith("permission.")) permissionEventsRaw.push(evt);
        if (evt.type === "permission.asked" && (evt.properties ?? evt).sessionID === sessionID) {
          const props = evt.properties ?? evt;
          repliedPermission = props;
          await env.client.postSessionIdPermissionsPermissionId({
            path: { id: sessionID, permissionID: props.id },
            body: { response: "once" },
          });
          return;
        }
      }
    })();

    const raced = await Promise.race([
      env.client.session
        .prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text: "run a shell command" }] } })
        .then(() => "prompt-resolved"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 25_000)),
    ]);

    console.log("\n=== Q: can a headless client resolve an \"ask\"-tier permission via the raw SSE + reply API? ===");
    if (raced === "timeout") {
      console.log("TIMEOUT after 25s: prompt() never resolved.");
      console.log("permission.asked observed before timeout:", repliedPermission ? JSON.stringify(repliedPermission) : "no - never saw one");
      console.log("Raw permission.* events seen:", JSON.stringify(permissionEventsRaw));
      console.log("All event types seen on the subscription in the meantime:", [...new Set(seenEventTypes)].join(", ") || "(none at all)");
      return { outcome: "timeout", repliedPermission, permissionEventsRaw, seenEventTypes };
    }
    const parts = await env.transcript(sessionID);
    const toolPart = parts.find((p) => p.type === "tool" && p.tool === "bash");
    console.log("permission.asked observed:", JSON.stringify(repliedPermission));
    console.log("bash ToolPart after reply:", toolPart ? JSON.stringify(toolPart.state) : "none found");
    console.log(
      toolPart?.state.status === "completed"
        ? "CONFIRMED: subscribing for permission.asked and replying via postSessionIdPermissionsPermissionId really does unblock an \"ask\"-tier call, the same mechanism a real TUI uses."
        : "NOT CONFIRMED: see raw state above.",
    );
    await autoApprove;
    return { outcome: "resolved", repliedPermission, toolState: toolPart?.state ?? null };
  } finally {
    await env.cleanup();
  }
}

const denyResult = await probeDenyTier();
const askResult = await probeAskTier();

await saveEvidence(EVIDENCE_DIR, { "deny-tier.json": denyResult, "ask-tier.json": askResult });
console.log(`\nFull results written to ${EVIDENCE_DIR}/`);
// The SSE subscription's underlying socket can keep the event loop alive
// past the point where there's anything left to do - force a clean exit
// rather than leaving this hanging for whatever reaps it.
process.exit(0);
