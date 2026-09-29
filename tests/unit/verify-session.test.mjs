// verify-session.ts takes its opencode client, serverUrl and shell as arguments, so it runs here with fakes - no real opencode, no model.
import { test } from "node:test";
import assert from "node:assert/strict";

const { VerifySession } = await import("../../plugins/verify-session/verify-session.ts");

function setup({ messages } = {}) {
  const calls = { created: [], prompts: [], fetches: [] };
  const client = {
    session: {
      create: async ({ body }) => (calls.created.push(body), { data: { id: "new-session" } }),
      promptAsync: async (args) => (calls.prompts.push(args), {}),
      messages: async () => ({ data: messages ?? [] }),
    },
  };
  const $ = (strings, ...vals) => {
    const out = `[${vals.flat().join(" ")}]`;
    const p = { quiet: () => p, nothrow: () => p, text: async () => out };
    return p;
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (calls.fetches.push({ url: String(url), body: JSON.parse(init.body) }), {});
  return { calls, restore: () => (globalThis.fetch = origFetch), hooksP: VerifySession({ client, serverUrl: new URL("http://127.0.0.1:4096"), $ }) };
}

const msg = (role, text, synthetic = false) => ({ info: { role }, parts: [{ type: "text", text, synthetic }] });

test("registers a /verify command", async () => {
  const { hooksP, restore } = setup();
  const config = {};
  await (await hooksP).config(config);
  restore();
  assert.ok(config.command.verify.template);
});

test("/verify creates a separate session, seeds it with claim + user requests + git evidence, and switches the TUI to it", async () => {
  const { hooksP, calls, restore } = setup({
    messages: [msg("user", "make add() add"), msg("assistant", "I finished it, tests pass"), { info: { role: "assistant" }, parts: [{ type: "tool", text: "SECRET-REASONING" }] }, msg("user", "synthetic", true)],
  });
  const hooks = await hooksP;
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "verify", sessionID: "origin", arguments: "add works" }, output);
  restore();

  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].parentID, undefined, "must be a top-level session, not a subtask");
  const prompt = calls.prompts[0].body.parts[0].text;
  assert.equal(calls.prompts[0].path.id, "new-session");
  assert.match(prompt, /add works/);
  assert.match(prompt, /make add\(\) add/);
  assert.match(prompt, /git diff/);
  assert.match(prompt, /UNVERIFIED/);
  assert.match(prompt, /I finished it, tests pass/, "the last assistant text is passed as the unverified report");
  assert.doesNotMatch(prompt, /SECRET-REASONING/, "tool calls / reasoning must not leak");
  assert.doesNotMatch(prompt, /synthetic/);
  assert.deepEqual(calls.fetches, [{ url: "http://127.0.0.1:4096/tui/select-session", body: { sessionID: "new-session" } }]);
  assert.match(output.parts[0].text, /new-session/);
});

test("ignores other commands", async () => {
  const { hooksP, calls, restore } = setup();
  const hooks = await hooksP;
  const output = { parts: [] };
  await hooks["command.execute.before"]({ command: "other", sessionID: "s", arguments: "" }, output);
  restore();
  assert.equal(calls.created.length, 0);
  assert.deepEqual(output.parts, []);
});

test("keeps every user message when they fit, and the first ones plus the newest when they don't", async () => {
  const many = Array.from({ length: 40 }, (_, i) => msg("user", `req-${i} ${"x".repeat(1000)}`));
  const { hooksP, calls, restore } = setup({ messages: many });
  const hooks = await hooksP;
  await hooks["command.execute.before"]({ command: "verify", sessionID: "o", arguments: "" }, { parts: [] });
  restore();
  const prompt = calls.prompts[0].body.parts[0].text;
  assert.match(prompt, /req-0 /);
  assert.match(prompt, /req-1 /);
  assert.match(prompt, /req-39 /);
  assert.match(prompt, /earlier messages omitted/);
  assert.doesNotMatch(prompt, /req-10 /);

  const few = setup({ messages: [msg("user", "a"), msg("user", "b"), msg("user", "c"), msg("user", "d"), msg("user", "e"), msg("user", "f"), msg("user", "g")] });
  await (await few.hooksP)["command.execute.before"]({ command: "verify", sessionID: "o", arguments: "" }, { parts: [] });
  few.restore();
  assert.match(few.calls.prompts[0].body.parts[0].text, /1\. a[\s\S]*7\. g/);
});
