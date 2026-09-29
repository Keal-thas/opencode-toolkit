// plugins/hook-logger/hook-logger.ts computes its output directory from os.homedir()
// at module-load time, so HOME must be pointed at a scratch dir *before*
// the module is imported.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeHome = await mkdtemp(join(tmpdir(), "hook-logger-test-"));
process.env.HOME = fakeHome;
// os.homedir() reads USERPROFILE on Windows (not HOME) - without this the plugin writes into the real home there.
process.env.USERPROFILE = fakeHome;

const { HookLogger } = await import("../../plugins/hook-logger/hook-logger.ts");

after(() => rm(fakeHome, { recursive: true, force: true }));

test("writes a chat.message event as a JSONL line under $HOME/opencode-hook-output", async () => {
  const hooks = await HookLogger();
  await hooks["chat.message"]({ sessionID: "s1" }, { parts: [] });

  const file = join(fakeHome, "opencode-hook-output", "chat.message.jsonl");
  const lines = (await readFile(file, "utf-8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.input.sessionID, "s1");
  assert.ok(entry.ts, "each line should carry a timestamp");
});

test("appends to the per-event file across calls instead of overwriting", async () => {
  const hooks = await HookLogger();
  await hooks.event({ event: { type: "a" } });
  await hooks.event({ event: { type: "b" } });

  const file = join(fakeHome, "opencode-hook-output", "event.jsonl");
  const lines = (await readFile(file, "utf-8")).trim().split("\n");
  const types = lines.map((l) => JSON.parse(l).event.type);
  assert.deepEqual(types, ["a", "b"]);
});

test("routes different hook names to their own file", async () => {
  const hooks = await HookLogger();
  await hooks["tool.execute.after"]({ tool: "bash" }, { output: "ok" });

  const file = join(fakeHome, "opencode-hook-output", "tool.execute.after.jsonl");
  const entry = JSON.parse((await readFile(file, "utf-8")).trim());
  assert.equal(entry.input.tool, "bash");
  assert.equal(entry.output.output, "ok");
});

test("serializes circular references as a marker instead of throwing", async () => {
  const hooks = await HookLogger();
  const circular = { tool: "bash" };
  circular.self = circular;

  await assert.doesNotReject(() => hooks["tool.execute.before"](circular, {}));

  const file = join(fakeHome, "opencode-hook-output", "tool.execute.before.jsonl");
  const entry = JSON.parse((await readFile(file, "utf-8")).trim());
  assert.equal(entry.input.self, "[Circular]");
});
