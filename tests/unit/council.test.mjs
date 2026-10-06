// council.ts takes its opencode client as an argument, so it runs here with a fake - no real opencode, no model.
// It imports zod, which this plugin declares as its own dependency; the test imports it through the same resolution a real install would use.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The plugin reads its optional config from the home directory on every call.
const fakeHome = await mkdtemp(join(tmpdir(), "council-test-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome; // os.homedir() reads USERPROFILE on Windows
delete process.env.COUNCIL_CONFIG_ENV;
after(() => rm(fakeHome, { recursive: true, force: true }));
const configDir = join(fakeHome, ".config", "kealthas-dev", "opencode-council");

const { Council } = await import("../../plugins/council/council.ts");

// `answers` maps an agent name (and, for seats, the seat name found in the system prompt) to what the fake model replies with:
// a string, an Error to reject with, or "hang" to never answer.
function setup(reply) {
  const calls = { created: [], prompts: [], aborted: [], deleted: [] };
  let n = 0;
  const client = {
    session: {
      create: async (args) => (calls.created.push(args), { data: { id: `ses${++n}` } }),
      prompt: async (args) => {
        calls.prompts.push(args);
        const r = await reply(args);
        if (r === "hang") return new Promise(() => {});
        if (r instanceof Error) throw r;
        return { data: { parts: typeof r === "string" ? [{ type: "text", text: r }] : r } };
      },
      abort: async (args) => (calls.aborted.push(args.path.id), {}),
      delete: async (args) => (calls.deleted.push(args.path.id), {}),
    },
  };
  return { calls, hooksP: Council({ client }) };
}

const ctx = (extra = {}) => ({ sessionID: "origin", directory: "/proj", abort: new AbortController().signal, metadata() {}, ...extra });
const run = async (hooks, args = { question: "Q?" }, c = ctx()) => hooks.tool.council.execute(args, c);
const seatOf = (system) => /Your angle: (what is wrong|structure|the smallest)/.exec(system)?.[1];

const simple = (a) =>
  a.body.agent === "council-synth"
    ? "CONSENSUS: majority\nANSWER: do X\nDISAGREEMENTS: none"
    : `answer from ${seatOf(a.body.system)}`;

test("asks every seat in parallel in the project directory, then synthesizes, and reports every answer verbatim", async () => {
  // Each seat's reply is held until all three have been asked: a council that asked them one after another would never finish.
  const waiting = [];
  const { hooksP, calls } = setup((a) => {
    if (a.body.agent !== "council-seat") return simple(a);
    return new Promise((resolve) => {
      waiting.push(() => resolve(simple(a)));
      if (waiting.length === 3) waiting.forEach((release) => release());
    });
  });
  const hooks = await hooksP;
  const out = await run(hooks, { question: "Which?", context: "see a.ts" });

  assert.equal(waiting.length, 3, "all seats were asked before any answered");
  const seatCalls = calls.prompts.filter((p) => p.body.agent === "council-seat");
  assert.equal(seatCalls.length, 3);
  for (const p of seatCalls) {
    assert.match(p.body.system, /one of several independent advisors/);
    assert.match(p.body.parts[0].text, /Which\?[\s\S]*## Context\nsee a\.ts/);
  }
  assert.ok(calls.created.every((c) => c.query.directory === "/proj"), "child sessions run in the project directory so seats can read it");
  const synth = calls.prompts.find((p) => p.body.agent === "council-synth");
  assert.match(synth.body.parts[0].text, /### skeptic\nanswer from what is wrong[\s\S]*### architect[\s\S]*### pragmatist/);
  assert.match(out, /^# Council report \(3 of 3 seats answered\)/);
  assert.match(out, /CONSENSUS: majority/);
  assert.match(out, /## Seat answers \(verbatim\)\n### skeptic\nanswer from what is wrong/);
  assert.deepEqual([...calls.deleted].sort(), calls.created.map((_, i) => `ses${i + 1}`), "every child session is deleted");
});

test("a seat that fails or answers nothing is reported as missing and left out of the synthesis", async () => {
  const { hooksP, calls } = setup((a) => {
    if (a.body.agent === "council-synth") return simple(a);
    const seat = seatOf(a.body.system);
    if (seat === "structure") return new Error("model server down");
    if (seat === "the smallest") return []; // no text part at all
    return simple(a);
  });
  const out = await run(await hooksP);
  assert.match(out, /1 of 3 seats answered/);
  assert.match(out, /### architect\n\(no answer: model server down\)/);
  assert.match(out, /### pragmatist\n\(no answer: empty answer\)/);
  assert.equal(calls.prompts.filter((p) => p.body.agent === "council-synth").length, 0, "one answer is no consensus: no synthesis call");
  assert.match(out, /Only one seat answered/);
});

test("with no answers at all it throws, carrying the reasons", async () => {
  const { hooksP } = setup(() => new Error("boom"));
  await assert.rejects(async () => run(await hooksP), /no seat answered[\s\S]*boom/);
});

test("when the synthesis fails the seat answers are still returned", async () => {
  const { hooksP } = setup((a) => (a.body.agent === "council-synth" ? new Error("synth down") : simple(a)));
  const out = await run(await hooksP);
  assert.match(out, /The synthesis failed \(synth down\)/);
  assert.match(out, /### skeptic\nanswer from what is wrong/);
});

test("a seat that hangs is aborted at its timeout and does not block the others", async () => {
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({ seatTimeoutSeconds: 0.05, seats: [{ name: "a", prompt: "angle A" }, { name: "b", prompt: "angle B" }, { name: "c", prompt: "angle C" }] }),
  );
  try {
    const { hooksP, calls } = setup((a) => (a.body.system.includes("angle B") ? "hang" : a.body.agent === "council-synth" ? simple(a) : "fine"));
    const out = await run(await hooksP);
    assert.match(out, /2 of 3 seats answered/);
    assert.match(out, /### b\n\(no answer: timed out after 0\.05s\)/);
    assert.equal(calls.aborted.length, 1, "the hanging session was aborted");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("config: custom seats, a provider/model override that may itself contain slashes, and validation", async () => {
  await mkdir(configDir, { recursive: true });
  try {
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ seats: [{ name: "a", prompt: "angle A", model: "vllm/org/qwen" }, { name: "b", prompt: "angle B" }], synthesizer: { model: "vllm/big" } }),
    );
    const { hooksP, calls } = setup(() => "ok");
    await run(await hooksP);
    const byAgent = (agent) => calls.prompts.filter((p) => p.body.agent === agent);
    assert.deepEqual(byAgent("council-seat").find((p) => p.body.system.includes("angle A")).body.model, { providerID: "vllm", modelID: "org/qwen" });
    assert.equal(byAgent("council-seat").find((p) => p.body.system.includes("angle B")).body.model, undefined);
    assert.deepEqual(byAgent("council-synth")[0].body.model, { providerID: "vllm", modelID: "big" });

    await writeFile(join(configDir, "config.json"), JSON.stringify({ seats: [{ name: "only", prompt: "x" }] }));
    await assert.rejects(async () => run(await setup(() => "ok").hooksP), /invalid config/);
    await writeFile(join(configDir, "config.json"), "{ not json");
    await assert.rejects(async () => run(await setup(() => "ok").hooksP), /cannot read/);
    await writeFile(join(configDir, "config.json"), JSON.stringify({ seats: [{ name: "a", prompt: "x", model: "nomodel" }, { name: "b", prompt: "y" }] }));
    const out = await run(await setup(() => "ok").hooksP);
    assert.match(out, /model must look like "provider\/model"/, "a bad model on one seat fails that seat, not the whole council");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("aborting the calling tool call aborts every child session and throws", async () => {
  const controller = new AbortController();
  const { hooksP, calls } = setup((a) => {
    if (a.body.agent === "council-seat") {
      queueMicrotask(() => controller.abort());
      return "hang";
    }
    return simple(a);
  });
  await assert.rejects(async () => run(await hooksP, { question: "Q" }, ctx({ abort: controller.signal })), /cancelled|timed out/);
});

test("registers the seat and synthesizer agents and a /council command without overriding the user's own", async () => {
  const hooks = await setup(() => "x").hooksP;
  const config = { agent: { "council-seat": { description: "mine" } } };
  await hooks.config(config);
  assert.equal(config.agent["council-seat"].description, "mine");
  assert.deepEqual(config.agent["council-synth"].permission, { "*": "deny" });
  assert.equal(config.agent["council-synth"].hidden, true);
  assert.match(config.command.council.template, /council tool[\s\S]*\$ARGUMENTS/);

  const fresh = {};
  await hooks.config(fresh);
  assert.deepEqual(fresh.agent["council-seat"].permission, { "*": "deny", read: "allow", glob: "allow", grep: "allow" });
  assert.equal(Object.keys(fresh.agent["council-seat"].permission)[0], "*", "the catch-all deny comes first: the last matching rule wins");
});
