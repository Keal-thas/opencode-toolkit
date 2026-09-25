#!/usr/bin/env node
// Capability probe, not a pass/fail test - see tests/capability-probes/README.md.
//
// permissions.verify.mjs confirmed the two blanket tiers (deny, ask) work via
// some real mechanism. This asks the sharper question: does opencode's
// granular, pattern-based permission matching (permissions.mdx's "Granular
// Rules (Object Syntax)") actually route different commands to the RIGHT
// tier, not just that tiers work in isolation? One server, one config:
//
//   permission.bash = { "*": "ask", "echo allow-me *": "allow", "echo deny-me *": "deny" }
//
// Four commands, four expected outcomes:
//   1. matches the "allow-me" pattern  -> should run for real, no permission
//      ask at all.
//   2. matches the "deny-me" pattern   -> should be blocked, no permission
//      ask at all (this is the interesting one: permissions.verify.mjs found
//      that a *blanket* "deny" removes the tool from the model's tool list
//      entirely - a *per-pattern* deny can't do that, since the same tool is
//      allowed for other patterns, so this checks what it does instead).
//   3. matches neither -> falls through to the "*": "ask" catch-all, and gets
//      auto-approved via the same event.subscribe() + reply mechanism
//      permissions.verify.mjs proved out - confirms a real command actually
//      runs after approval.
//   4. same as 3, but auto-REJECTED instead - permissions.verify.mjs only
//      ever tried approving; this confirms the same round trip can also
//      really say no.
//
// Run manually inside the docker/ sandbox:
//   docker/dev.sh run --rm opencode-dev bash -c \
//     'cd tests/capability-probes && npm install --no-audit --no-fund && node permission-rules.verify.mjs'
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setupProbeEnv, saveEvidence } from "./lib/harness.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(SCRIPT_DIR, "..", "..", ".local", "capability-probes", "permission-rules");

const env = await setupProbeEnv({
  config: {
    permission: {
      bash: { "*": "ask", "echo allow-me *": "allow", "echo deny-me *": "deny" },
    },
  },
});

// One shared event subscription across every case in this run (permission
// tiers are fixed per server, but which sessions get asked isn't, so this
// has to be set up once and demultiplexed by sessionID).
const pendingReplies = new Map(); // sessionID -> "once" | "reject", set before that case's prompt() call
const askedForSession = new Map(); // sessionID -> array of raw permission.asked properties
const watcher = (async () => {
  const sub = await env.client.event.subscribe();
  for await (const evt of sub.stream) {
    if (evt.type !== "permission.asked") continue;
    const props = evt.properties ?? evt;
    if (!askedForSession.has(props.sessionID)) askedForSession.set(props.sessionID, []);
    askedForSession.get(props.sessionID).push(props);
    const reply = pendingReplies.get(props.sessionID);
    if (reply) {
      await env.client.postSessionIdPermissionsPermissionId({
        path: { id: props.sessionID, permissionID: props.id },
        body: { response: reply },
      });
    }
  }
})();
watcher.catch(() => {}); // server.close() during cleanup ends the stream - don't let that reject unhandled

async function runCase(name, command, { replyIfAsked } = {}) {
  env.provider.setPlan([{ toolCall: { id: `call_${name}`, name: "bash", args: { command } } }, { text: `${name} done` }]);
  const created = await env.client.session.create({ body: { title: `permission-rules:${name}` } });
  const sessionID = created.data.id;
  if (replyIfAsked) pendingReplies.set(sessionID, replyIfAsked);

  const raced = await Promise.race([
    env.client.session
      .prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text: `run: ${command}` }] } })
      .then(() => "resolved"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 20_000)),
  ]);

  const parts = raced === "timeout" ? await env.transcript(sessionID) : await env.transcript(sessionID);
  const toolPart = parts.find((p) => p.type === "tool" && (p.tool === "bash" || p.tool === "invalid"));
  return {
    name,
    command,
    raced,
    wasAsked: askedForSession.has(sessionID),
    tool: toolPart?.tool ?? null,
    state: toolPart?.state ?? null,
  };
}

try {
  const results = {};

  results.allowPattern = await runCase("allow-pattern", "echo allow-me please");
  results.denyPattern = await runCase("deny-pattern", "echo deny-me please");
  results.askApprove = await runCase("ask-then-approve", "echo neutral-approve-please", { replyIfAsked: "once" });
  results.askReject = await runCase("ask-then-reject", "echo neutral-reject-please", { replyIfAsked: "reject" });

  console.log("\n=== Does the \"allow-me *\" pattern actually let its match through without asking? ===");
  console.log(JSON.stringify(results.allowPattern, null, 2));
  console.log(
    !results.allowPattern.wasAsked && results.allowPattern.state?.status === "completed" && results.allowPattern.state?.output?.includes("allow-me please")
      ? "CONFIRMED: ran for real, no ask."
      : "NOT CONFIRMED - see raw result above.",
  );

  console.log("\n=== Does the \"deny-me *\" pattern actually block its match without asking? ===");
  console.log(JSON.stringify(results.denyPattern, null, 2));
  console.log(
    !results.denyPattern.wasAsked && results.denyPattern.state?.status === "error"
      ? "CONFIRMED blocked, no ask - see raw error text above for the exact mechanism (permission-denial error vs. invalid-tool, unlike blanket deny)."
      : "NOT CONFIRMED - see raw result above.",
  );

  console.log("\n=== Does a command matching neither pattern actually fall through to \"*\": \"ask\", and does approving really let it run? ===");
  console.log(JSON.stringify(results.askApprove, null, 2));
  console.log(
    results.askApprove.wasAsked && results.askApprove.state?.status === "completed" && results.askApprove.state?.output?.includes("neutral-approve-please")
      ? "CONFIRMED: was asked, approved, ran for real with the real command output."
      : "NOT CONFIRMED - see raw result above.",
  );

  console.log("\n=== Same fallthrough, but replying \"reject\" instead - does that actually block it? ===");
  console.log(JSON.stringify(results.askReject, null, 2));
  console.log(
    results.askReject.wasAsked && results.askReject.state?.status === "error" && !results.askReject.state?.output?.includes("neutral-reject-please")
      ? "CONFIRMED: was asked, rejected, command never actually ran - the model only saw a rejection, never real output."
      : "NOT CONFIRMED - see raw result above.",
  );

  await saveEvidence(EVIDENCE_DIR, { "results.json": results, "requests.json": env.provider.capturedRequests });
  console.log(`\nFull results written to ${EVIDENCE_DIR}/`);
} finally {
  await env.cleanup();
  process.exit(0);
}
