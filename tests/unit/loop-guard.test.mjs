// loop-guard.ts only reads what opencode passes to its hooks, so it runs here with plain objects - no opencode, no model.
import { test } from "node:test";
import assert from "node:assert/strict";

const { LoopGuard } = await import("../../plugins/loop-guard/loop-guard.ts");

// Drives one tool call through the hooks the way opencode does: before, then (if it did not throw and the tool succeeded) after.
async function call(hooks, { tool = "read", args = { filePath: "/a" }, output = "same", sessionID = "s1", fail = false } = {}) {
  const callID = `c${Math.random()}`;
  await hooks["tool.execute.before"]({ tool, sessionID, callID }, { args });
  if (fail) return { output: undefined };
  const out = { title: "t", output, metadata: {} };
  await hooks["tool.execute.after"]({ tool, sessionID, callID, args }, out);
  return out;
}

test("appends a notice from the 3rd identical call with an identical result", async () => {
  const hooks = await LoopGuard();
  assert.equal((await call(hooks)).output, "same");
  assert.equal((await call(hooks)).output, "same");
  const third = await call(hooks);
  assert.match(third.output, /^same\n\n\[REPEATED TOOL CALL - STOP\]/);
});

test("the notice does not make the next identical result look like a change", async () => {
  const hooks = await LoopGuard();
  for (let i = 0; i < 3; i++) await call(hooks);
  const fourth = await call(hooks);
  assert.match(fourth.output, /\[REPEATED TOOL CALL - STOP\]/);
  assert.equal(fourth.output.match(/REPEATED TOOL CALL/g).length, 1);
});

test("a different result restarts the run, so a legitimate re-read never accumulates", async () => {
  const hooks = await LoopGuard();
  await call(hooks, { output: "v1" });
  await call(hooks, { output: "v1" });
  await call(hooks, { output: "v2" });
  const out = await call(hooks, { output: "v2" });
  assert.equal(out.output, "v2");
});

test("different arguments restart the run, and key order does not matter", async () => {
  const hooks = await LoopGuard();
  await call(hooks, { args: { a: 1, b: 2 } });
  await call(hooks, { args: { b: 2, a: 1 } });
  const third = await call(hooks, { args: { a: 1, b: 2 } });
  assert.match(third.output, /REPEATED TOOL CALL/);
  const other = await call(hooks, { args: { a: 1, b: 3 } });
  assert.equal(other.output, "same");
});

test("refuses the 6th identical read-only call", async () => {
  const hooks = await LoopGuard();
  for (let i = 0; i < 5; i++) await call(hooks, { tool: "grep", args: { pattern: "x" } });
  await assert.rejects(() => call(hooks, { tool: "grep", args: { pattern: "x" } }), /Refusing to run "grep"/);
  // still refused until something different happens
  await assert.rejects(() => call(hooks, { tool: "grep", args: { pattern: "x" } }), /Refusing/);
  assert.equal((await call(hooks, { tool: "grep", args: { pattern: "y" } })).output, "same");
});

test("counts failing calls too, since a failing tool never reaches the after hook", async () => {
  const hooks = await LoopGuard();
  for (let i = 0; i < 5; i++) await call(hooks, { fail: true });
  await assert.rejects(() => call(hooks, { fail: true }), /Refusing to run "read"/);
});

test("warns but never refuses a tool with side effects", async () => {
  const hooks = await LoopGuard();
  let last;
  for (let i = 0; i < 8; i++) last = await call(hooks, { tool: "bash", args: { command: "make" } });
  assert.match(last.output, /REPEATED TOOL CALL/);
});

test("a new user message resets the session, and sessions are independent", async () => {
  const hooks = await LoopGuard();
  for (let i = 0; i < 5; i++) await call(hooks, { sessionID: "a" });
  assert.equal((await call(hooks, { sessionID: "b" })).output, "same", "another session is unaffected");
  await hooks["chat.message"]({ sessionID: "a" }, { parts: [] });
  assert.equal((await call(hooks, { sessionID: "a" })).output, "same");
});

test("ignores the task tool and non-string output", async () => {
  const hooks = await LoopGuard();
  for (let i = 0; i < 8; i++) assert.equal((await call(hooks, { tool: "task", args: { prompt: "x" } })).output, "same");
  const out = { title: "t", output: { not: "a string" }, metadata: {} };
  await hooks["tool.execute.before"]({ tool: "read", sessionID: "s9", callID: "x" }, { args: {} });
  await assert.doesNotReject(() => hooks["tool.execute.after"]({ tool: "read", sessionID: "s9", callID: "x", args: {} }, out));
});
