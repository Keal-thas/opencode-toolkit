// llm-review-gate.ts takes its opencode `client` as a constructor argument,
// so it can be exercised with a fake client here - no real opencode session,
// no model server, no network. outDir is still homedir()-derived at import
// time, so HOME is redirected first like the other plugin tests.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeHome = await mkdtemp(join(tmpdir(), "llm-review-gate-test-"));
process.env.HOME = fakeHome;

const { LlmReviewGate } = await import("../../plugins/llm-review-gate/llm-review-gate.ts");
const logFile = join(fakeHome, "opencode-hook-output", "llm-review.jsonl");

after(() => rm(fakeHome, { recursive: true, force: true }));

function textResponse(text) {
  return { data: { parts: [{ type: "text", text }] } };
}

// Each test gets its own fake client/gate instance so reviewSessionIDs state
// never leaks between tests. Each review() call now creates and then deletes
// its own one-shot session (see the comment above `review()` in
// llm-review-gate.ts), so the fake client needs both create and delete
// stubs; deletedSessionIDs lets tests assert cleanup actually happened.
function makeClient(promptImpl) {
  let sessionCounter = 0;
  const deletedSessionIDs = [];
  const client = {
    session: {
      create: async () => ({ data: { id: `review-session-${++sessionCounter}` } }),
      prompt: promptImpl,
      delete: async ({ path }) => {
        deletedSessionIDs.push(path.id);
        return { data: {} };
      },
    },
  };
  return { client, deletedSessionIDs };
}

async function makeGate(promptImpl) {
  const { client } = makeClient(promptImpl);
  return LlmReviewGate({ client });
}

async function lastLogEntry() {
  const lines = (await readFile(logFile, "utf-8")).trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

test("routes the review prompt through the dedicated review-gate agent, not the default persona", async () => {
  let seenAgent;
  const hooks = await makeGate(async ({ body }) => {
    seenAgent = body.agent;
    return textResponse("ALLOW");
  });
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "ls" } });
  // Regression guard: without an explicit `agent`, opencode falls back to
  // the default primary agent (build/plan/general), whose configured
  // `prompt` (deploy/system-prompt.txt) gets prepended ahead of
  // REVIEW_SYSTEM_PROMPT rather than being replaced by it - see the comment
  // above the `agent: "review-gate"` line in llm-review-gate.ts.
  assert.equal(seenAgent, "review-gate");
});

test("registers the review_verdict tool under the exact name deploy/opencode.json.example grants permission for", async () => {
  const hooks = await makeGate(async () => textResponse("ALLOW"));
  assert.ok(hooks.tool?.review_verdict, "expected hooks.tool.review_verdict to be registered");
});

test("prefers the review_verdict tool call over parsing free text when the model calls it", async () => {
  let hooks;
  hooks = await makeGate(async ({ path }) => {
    // Simulate opencode dispatching a model-issued tool call - even though
    // the transcript also contains stray "ALLOW" text (e.g. a courtesy
    // remark after calling the tool), the structured verdict must win.
    await hooks.tool.review_verdict.execute({ allow: false, reason: "force-pushes to a shared branch" }, { sessionID: path.id });
    return textResponse("ALLOW");
  });

  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "git push --force" } }),
    /force-pushes to a shared branch/,
  );
  assert.equal((await lastLogEntry()).verdict, "block");
});

test("falls back to parsing free text when the model never calls review_verdict", async () => {
  const hooks = await makeGate(async () => textResponse("BLOCK: rewrites git history"));
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "git rebase -i" } }),
    /rewrites git history/,
  );
  assert.equal((await lastLogEntry()).verdict, "block");
});

test("uses a fresh one-shot session per review and deletes it afterward, instead of one long-lived session", async () => {
  const { client, deletedSessionIDs } = makeClient(async () => textResponse("ALLOW"));
  const hooks = await LlmReviewGate({ client });

  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "ls" } });
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c2" }, { args: { command: "pwd" } });

  // A reused session would grow that session's own message history by one
  // command+verdict turn per review, quietly inflating the context sent on
  // every later call - so each review must get its own session, and that
  // session must be cleaned up right after, not accumulated forever.
  assert.deepEqual(deletedSessionIDs, ["review-session-1", "review-session-2"]);
});

test("allows a bash command when the review verdict is ALLOW", async () => {
  const hooks = await makeGate(async () => textResponse("ALLOW"));
  await assert.doesNotReject(() =>
    hooks["tool.execute.before"]({ tool: "bash", sessionID: "user-session", callID: "c1" }, { args: { command: "ls -la" } }),
  );
  assert.equal((await lastLogEntry()).verdict, "allow");
});

test("blocks a bash command when the review verdict is BLOCK, surfacing the stated reason", async () => {
  const hooks = await makeGate(async () => textResponse("BLOCK: deletes the whole home directory"));
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "rm -rf ~" } }),
    /deletes the whole home directory/,
  );
  assert.equal((await lastLogEntry()).verdict, "block");
});

test("never sends non-gated tools (e.g. edit) to review", async () => {
  let called = false;
  const hooks = await makeGate(async () => {
    called = true;
    return textResponse("BLOCK: should never run");
  });
  await hooks["tool.execute.before"]({ tool: "edit", sessionID: "s", callID: "c1" }, { args: { filePath: "x" } });
  assert.equal(called, false);
});

test("never reviews the review session's own tool calls while that review is in flight (no self-recursion)", async () => {
  let calls = 0;
  let hooks;
  hooks = await makeGate(async ({ path }) => {
    calls++;
    // Simulate the model, while being reviewed, somehow triggering a nested
    // bash call inside its own still-in-flight review session - this must
    // be skipped outright, not recursively reviewed. With one-shot sessions
    // this is the only window where self-recursion is even possible: the
    // session ID is deleted from reviewSessionIDs as soon as this review()
    // call finishes, so only a *nested* call during this in-flight prompt
    // (not some later, unrelated call) can ever collide with it.
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: path.id, callID: "nested" }, { args: { command: "rm -rf /" } });
    return textResponse("ALLOW");
  });

  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "user-session", callID: "c1" }, { args: { command: "ls" } });
  assert.equal(calls, 1, "the nested in-flight call must be skipped, not recursively reviewed");
});

test("fails open (allows) when the review call throws, per FAIL_OPEN_ON_ERROR default", async () => {
  const hooks = await makeGate(async () => {
    throw new Error("model server down");
  });
  await assert.doesNotReject(() =>
    hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "ls" } }),
  );
  const entry = await lastLogEntry();
  assert.match(entry.decision, /fail-open/);
  assert.match(entry.error, /model server down/);
});

test("allows when the verdict text can't be parsed as ALLOW/BLOCK (fail-open default)", async () => {
  const hooks = await makeGate(async () => textResponse("uh, maybe? not sure"));
  await assert.doesNotReject(() =>
    hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c1" }, { args: { command: "ls" } }),
  );
  assert.equal((await lastLogEntry()).verdict, "unclear");
});
