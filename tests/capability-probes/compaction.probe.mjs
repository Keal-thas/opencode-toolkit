#!/usr/bin/env node
// Capability probe, not a pass/fail test - see tests/capability-probes/README.md.
//
// How opencode manages context at runtime, three questions:
//   1. Big tool outputs - are bash / read / MCP tool results truncated before they enter the history, and what does the model actually receive?
//   2. Auto compaction - at what provider-reported token count does it trigger (default `reserved` vs. a configured one), what request does it send, what does the next request look like, and does `auto: false` really stop it?
//   3. Prune - are old tool outputs cleared from the history, and is that on or off by default?
// Token counts come from the fake provider's `usage` chunk, so the window can be made small without generating real volume.
//
// Run manually inside the docker/ sandbox:
//   docker/dev.sh run --rm opencode-dev bash -c \
//     'cd tests/capability-probes && npm install --no-audit --no-fund && node compaction.probe.mjs'
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setupProbeEnv, saveEvidence } from "./lib/harness.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(SCRIPT_DIR, "..", "..", ".local", "capability-probes", "compaction");
const MCP_SERVER = join(SCRIPT_DIR, "lib", "big-output-mcp.mjs");

const evidence = {};
const permission = { bash: "allow", read: "allow", edit: "allow", external_directory: "allow" };

async function withEnv(opts, fn) {
  const env = await setupProbeEnv(opts);
  try {
    return await fn(env);
  } finally {
    await env.cleanup();
  }
}

async function newSession(env, title) {
  // A custom title keeps opencode from sending its separate title-generator request, which would consume a plan round.
  return (await env.client.session.create({ body: { title } })).data.id;
}

async function turn(env, sessionID, text, plan) {
  env.provider.setPlan(plan);
  await Promise.race([
    env.client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("probe timeout after 60s")), 60_000)),
  ]);
}

const messages = async (env, sessionID) => (await env.client.session.messages({ path: { id: sessionID } })).data ?? [];
const toolMessages = (req) => (req.messages ?? []).filter((m) => m.role === "tool");
const textOf = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

// ---------------------------------------------------------------- 1. big tool outputs
console.log("=== 1. Big tool outputs (default config, 128K window) ===");
{
  const dir = await mkdtemp(join(tmpdir(), "compaction-probe-"));
  const bigFile = join(dir, "big.txt");
  await writeFile(bigFile, Array.from({ length: 5000 }, (_, i) => `file line ${i + 1} ${"z".repeat(40)}`).join("\n"));
  const cases = [
    { name: "bash: 100000 short lines (~590KB)", call: { id: "c1", name: "bash", args: { command: "seq 1 100000", description: "many lines" } } },
    { name: "bash: one 120KB line, no newline", call: { id: "c2", name: "bash", args: { command: "head -c 120000 /dev/zero | tr '\\0' x", description: "one long line" } } },
    { name: "read: 5000-line file", call: { id: "c3", name: "read", args: { filePath: bigFile } } },
    { name: "mcp: bigmcp_big 300KB", call: { id: "c4", name: "bigmcp_big", args: { kb: 300 } } },
  ];
  const rows = [];
  await withEnv(
    { config: { permission, mcp: { bigmcp: { type: "local", command: ["node", MCP_SERVER] } } }, modelLimit: { context: 128000, output: 8000 } },
    async (env) => {
      const sessionID = await newSession(env, "compaction.probe:big-outputs");
      for (const c of cases) {
        await turn(env, sessionID, `run ${c.name}`, [{ toolCall: c.call }, { text: "done" }]);
      }
      const parts = (await messages(env, sessionID)).flatMap((m) => m.parts ?? []).filter((p) => p.type === "tool");
      for (const c of cases) {
        const part = parts.find((p) => p.callID === c.call.id);
        const output = part?.state?.output ?? part?.state?.error ?? "";
        const sent = env.provider.capturedRequests
          .flatMap((r) => toolMessages(r))
          .map(textOf)
          .filter((t) => t.length > 0)
          .find((t) => output && t.slice(0, 200) === output.slice(0, 200));
        rows.push({
          case: c.name,
          status: part?.state?.status ?? "NO_TOOL_PART",
          outputChars: output.length,
          modelSawChars: sent?.length ?? null,
          truncatedMetadata: part?.state?.metadata?.truncated ?? null,
          outputPath: part?.state?.metadata?.outputPath ?? null,
          tail: output.slice(-300),
        });
      }
      evidence["1-big-outputs-requests.json"] = env.provider.capturedRequests;
    },
  );
  await rm(dir, { recursive: true, force: true });
  for (const r of rows) console.log(`- ${r.case}: status=${r.status} outputChars=${r.outputChars} modelSawChars=${r.modelSawChars} metadata.truncated=${r.truncatedMetadata} outputPath=${r.outputPath}\n    tail: ${JSON.stringify(r.tail)}`);
  evidence["1-big-outputs.json"] = rows;
}

// ---------------------------------------------------------------- 2. auto compaction
const CONTEXT = 20000;
const OUTPUT = 2000;

async function compactionCase(env, tokens) {
  const sessionID = await newSession(env, `compaction.probe:tokens-${tokens}`);
  const first = env.provider.capturedRequests.length;
  await turn(env, sessionID, "please run one command", [
    { toolCall: { id: `t${tokens}`, name: "bash", args: { command: "echo hi", description: "echo" } }, usage: { prompt_tokens: tokens } },
    { text: "COMPACT-SUMMARY-MARKER", usage: { prompt_tokens: 100 } },
    { text: "FINAL-AFTER-COMPACTION", usage: { prompt_tokens: 100 } },
  ]);
  const msgs = await messages(env, sessionID);
  const compacted = msgs.some((m) => m.info.role === "assistant" && m.info.summary === true);
  const requests = env.provider.capturedRequests.slice(first);
  return { tokens, compacted, requestCount: requests.length, requests, msgs };
}

async function compactionSweep(label, config, values, limit = { context: CONTEXT, output: OUTPUT }) {
  console.log(`\n=== 2. Auto compaction: ${label} (limit=${JSON.stringify(limit)}) ===`);
  return withEnv({ config: { permission, ...config }, modelLimit: limit }, async (env) => {
    const results = [];
    for (const tokens of values) {
      const r = await compactionCase(env, tokens);
      console.log(`- provider-reported prompt_tokens=${tokens}: compacted=${r.compacted} requests=${r.requestCount}`);
      results.push(r);
    }
    return results;
  });
}

const defaultSweep = await compactionSweep("default config", {}, [5000, 10000, 15000, 17000, 17900, 18100, 19500]);
const reservedSweep = await compactionSweep("compaction.reserved=10000", { compaction: { reserved: 10000 } }, [5000, 9000, 11000, 15000, 17900, 18100, 19500]);
const reservedLowSweep = await compactionSweep("compaction.reserved=500", { compaction: { reserved: 500 } }, [17900, 18100, 19400, 19600]);
// A model that also declares limit.input: the one case where `reserved` could matter.
const inputLimit = { context: CONTEXT, input: 16000, output: OUTPUT };
const inputDefaultSweep = await compactionSweep("limit.input=16000, default reserved", {}, [5000, 9000, 13000, 15000, 15900, 16100], inputLimit);
const inputReservedSweep = await compactionSweep("limit.input=16000, compaction.reserved=10000", { compaction: { reserved: 10000 } }, [5000, 5900, 6100, 9000, 13000], inputLimit);
// A custom provider model that declares no `limit` at all (what a hand-written provider block gets by default).
const noLimitSweep = await compactionSweep("no limit declared on the model", {}, [19500, 100000, 1000000], null);
const autoOffSweep = await compactionSweep("compaction.auto=false", { compaction: { auto: false } }, [19500]);

// What the compaction request and the request after it look like, from the default sweep's 19500 case.
{
  const hit = defaultSweep.find((r) => r.tokens === 19500);
  console.log("\n--- request sequence for prompt_tokens=19500 (default config) ---");
  hit.requests.forEach((req, i) => {
    const last = (req.messages ?? []).at(-1);
    console.log(
      `#${i + 1}: messages=${req.messages?.length} tools=${req.tools?.length ?? 0} stream_options=${JSON.stringify(req.stream_options ?? null)}\n    system[0..160]=${JSON.stringify(textOf(req.messages[0]).slice(0, 160))}\n    last(${last?.role})[0..400]=${JSON.stringify(textOf(last).slice(0, 400))}`,
    );
  });
  const post = hit.requests.at(-1);
  console.log(
    `after compaction: final request carries the summary=${JSON.stringify(post.messages.some((m) => textOf(m).includes("COMPACT-SUMMARY-MARKER")))} and still carries the original bash result=${JSON.stringify(post.messages.some((m) => m.role === "tool"))}`,
  );
  console.log("assistant messages in session:", hit.msgs.filter((m) => m.info.role === "assistant").map((m) => ({ agent: m.info.agent ?? m.info.mode, summary: m.info.summary ?? false, finish: m.info.finish, tokens: m.info.tokens })));
  evidence["2-compaction-19500-requests.json"] = hit.requests;
  evidence["2-compaction-19500-session.json"] = hit.msgs;
}
evidence["2-sweep-default.json"] = defaultSweep.map(({ tokens, compacted, requestCount }) => ({ tokens, compacted, requestCount }));
evidence["2-sweep-reserved-10000.json"] = reservedSweep.map(({ tokens, compacted, requestCount }) => ({ tokens, compacted, requestCount }));
evidence["2-sweep-reserved-500.json"] = reservedLowSweep.map(({ tokens, compacted, requestCount }) => ({ tokens, compacted, requestCount }));
evidence["2-sweep-input-limit-default.json"] = inputDefaultSweep.map(({ tokens, compacted }) => ({ tokens, compacted }));
evidence["2-sweep-input-limit-reserved-10000.json"] = inputReservedSweep.map(({ tokens, compacted }) => ({ tokens, compacted }));
evidence["2-sweep-no-limit.json"] = noLimitSweep.map(({ tokens, compacted }) => ({ tokens, compacted }));
evidence["2-sweep-auto-false.json"] = autoOffSweep.map(({ tokens, compacted, requestCount }) => ({ tokens, compacted, requestCount }));

// ---------------------------------------------------------------- 3. prune
async function pruneCase(label, config) {
  console.log(`\n=== 3. Prune: ${label} (200K window, 5 x ~49KB bash outputs in turn 1, then 3 text-only turns) ===`);
  return withEnv({ config: { permission, ...config }, modelLimit: { context: 200000, output: 8000 } }, async (env) => {
    const sessionID = await newSession(env, "compaction.probe:prune");
    const chunky = (n) => ({ toolCall: { id: `p${n}`, name: "bash", args: { command: `yes "padding line ${n} 0123456789 abcdefghij" | head -c 49000`, description: "chunk" } }, usage: { prompt_tokens: 1000 } });
    await turn(env, sessionID, "turn 1: gather output", [chunky(1), chunky(2), chunky(3), chunky(4), chunky(5), { text: "turn 1 done", usage: { prompt_tokens: 1000 } }]);
    for (const n of [2, 3, 4]) await turn(env, sessionID, `turn ${n}`, [{ text: `turn ${n} done`, usage: { prompt_tokens: 1000 } }]);
    await new Promise((r) => setTimeout(r, 2000)); // prune runs after the loop ends
    const parts = (await messages(env, sessionID)).flatMap((m) => m.parts ?? []).filter((p) => p.type === "tool");
    const lastReq = env.provider.capturedRequests.at(-1);
    const sentTools = toolMessages(lastReq).map(textOf);
    const cleared = sentTools.filter((t) => t.length < 200).length;
    console.log(`- tool parts with state.time.compacted set: ${parts.filter((p) => p.state?.time?.compacted).length}/${parts.length}`);
    console.log(`- last request: ${sentTools.length} tool messages, ${cleared} short/cleared; lengths=${JSON.stringify(sentTools.map((t) => t.length))}`);
    console.log(`- a cleared message reads: ${JSON.stringify(sentTools.find((t) => t.length < 200) ?? null)}`);
    evidence[`3-prune-${label.replace(/\W+/g, "-")}.json`] = { parts: parts.map((p) => ({ callID: p.callID, compacted: p.state?.time?.compacted ?? null })), sentLengths: sentTools.map((t) => t.length) };
  });
}
await pruneCase("default config", {});
await pruneCase("compaction.prune=true", { compaction: { prune: true } });
await pruneCase("compaction.prune=false", { compaction: { prune: false } });

await saveEvidence(EVIDENCE_DIR, evidence);
console.log(`\nEvidence written to ${EVIDENCE_DIR}/`);
