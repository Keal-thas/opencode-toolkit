// plugins/system-prompt-tools/system-prompt-tools.ts computes its dump path from os.homedir()
// at module-load time, so HOME must be pointed at a scratch dir *before*
// the module is imported.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeHome = await mkdtemp(join(tmpdir(), "system-prompt-tools-test-"));
process.env.HOME = fakeHome;
// os.homedir() reads USERPROFILE on Windows (not HOME) - without this the plugin writes into the real home there.
process.env.USERPROFILE = fakeHome;

const { SystemPromptTools } = await import("../../plugins/system-prompt-tools/system-prompt-tools.ts");
const dumpFile = join(fakeHome, ".local", "share", "opencode", "last-system-prompt.txt");

after(() => rm(fakeHome, { recursive: true, force: true }));

test("dumps the assembled system prompt with a model/session header", async () => {
  const hooks = await SystemPromptTools();
  await hooks["experimental.chat.system.transform"](
    { model: { providerID: "vllm", id: "qwen3.6-35b" }, sessionID: "sess-1" },
    { system: ["block one", "block two"] },
  );

  const contents = await readFile(dumpFile, "utf-8");
  assert.match(contents, /model: vllm\/qwen3\.6-35b/);
  assert.match(contents, /sessionID: sess-1/);
  assert.match(contents, /blocks: 2/);
  assert.match(contents, /SYSTEM PROMPT AS SENT TO MODEL/);
  assert.match(contents, /block one[\s\S]*next block[\s\S]*block two/);
});

test("overwrites the previous dump rather than appending (dump always reflects the latest request)", async () => {
  const hooks = await SystemPromptTools();
  await hooks["experimental.chat.system.transform"]({ model: {}, sessionID: "a" }, { system: ["first"] });
  await hooks["experimental.chat.system.transform"]({ model: {}, sessionID: "b" }, { system: ["second"] });

  const contents = await readFile(dumpFile, "utf-8");
  assert.ok(!contents.includes("first"), "stale content from the prior request should not remain");
  assert.ok(contents.includes("second"));
});
