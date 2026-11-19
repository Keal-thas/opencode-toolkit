#!/usr/bin/env node
// Integration test for the `verifier` agent and the `/verify` command shipped in deploy/opencode.jsonc.example.
// Runs a real `opencode run` (OPENCODE_BIN, default `opencode`) with the agent and command taken from that
// example file, and a fake local OpenAI-compatible server standing in for the model. The fake model replays
// scripted tool calls for the main agent and for the verifier and records what the verifier was shown.
// It proves, against a real opencode, that the verifier is offered no edit/write tools, that a bash call
// outside the allowlist does not run, that a read-only git call does, and that `/verify` injects git output
// into a fresh subagent session.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OPENCODE = process.env.OPENCODE_BIN ?? "opencode";

const parseJsonc = (text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
const example = parseJsonc(await readFile(join(REPO_ROOT, "deploy", "opencode.jsonc.example"), "utf-8"));
const verifierPrompt = await readFile(join(REPO_ROOT, "deploy", "verifier-prompt.txt"), "utf-8");
// The example refers to the prompt as {file:./verifier-prompt.txt}, relative to the config file: inline it here.
const verifierAgent = { ...example.agent.verifier, prompt: verifierPrompt };

const workDir = await mkdtemp(join(tmpdir(), "verifier-agent-test-"));
after(() => rm(workDir, { recursive: true, force: true }));

const exists = (p) => access(p).then(() => true, () => false);
const git = (cwd, ...args) => execFileAsync("git", args, { cwd });

function startFakeProvider(mainScript, verifierScript) {
  const seen = { main: [], verifier: [] };
  let mainStep = 0;
  let verifierStep = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = JSON.parse(body);
      const text = (m) => (Array.isArray(m.content) ? m.content.map((x) => x.text ?? "").join("\n") : String(m.content ?? ""));
      const system = p.messages.filter((m) => m.role === "system").map(text).join("\n");
      const toolNames = (p.tools ?? []).map((t) => t.function.name);
      const firstUser = text(p.messages.find((m) => m.role === "user") ?? { content: "" });
      const toolResults = p.messages.filter((m) => m.role === "tool").map(text);

      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: p.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const say = (content) => {
        res.write(chunk({ role: "assistant", content }, null));
        res.write(chunk({}, "stop"));
        res.end("data: [DONE]\n\n");
      };
      const call = (step, n) => {
        res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, null));
        res.write(chunk({}, "tool_calls"));
        res.end("data: [DONE]\n\n");
      };

      if (toolNames.length === 0) return say("title"); // session title generation
      if (system.includes("independent verifier")) {
        seen.verifier.push({ toolNames, firstUser, toolResults });
        const next = verifierScript[verifierStep++];
        return next ? call(next, `v${verifierStep}`) : say("VERDICT: UNVERIFIABLE");
      }
      seen.main.push({ toolNames, toolResults });
      const next = mainScript[mainStep++];
      return next ? call(next, `m${mainStep}`) : say("all done");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen })));
}

async function runOpencode(name, { mainScript = [], verifierScript = [], runArgs }) {
  const home = join(workDir, name, "home");
  const project = join(workDir, name, "project");
  const { server, port, seen } = await startFakeProvider(mainScript, verifierScript);
  try {
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(
      join(home, ".config", "opencode", "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "faketest/fake-model",
        provider: { faketest: { npm: "@ai-sdk/openai-compatible", name: "Fake", options: { baseURL: `http://127.0.0.1:${port}/v1` }, models: { "fake-model": { name: "Fake Model" } } } },
        agent: { verifier: verifierAgent },
        command: example.command,
      }),
    );
    // A small git repo: a committed file, a modified one and an untracked one.
    await git(project, "init", "-q", "-b", "master");
    await git(project, "config", "user.email", "t@example.com");
    await git(project, "config", "user.name", "t");
    await writeFile(join(project, "a.txt"), "one\n");
    await writeFile(join(project, "victim.txt"), "keep me\n");
    await git(project, "add", ".");
    await git(project, "commit", "-q", "-m", "init");
    await writeFile(join(project, "a.txt"), "one\ntwo-changed-line\n");
    await writeFile(join(project, "new.txt"), "untracked\n");

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home, // os.homedir() reads USERPROFILE on Windows
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      PWD: project, // opencode takes its project directory from $PWD
    };
    // `opencode run` reads piped stdin as part of the prompt and waits for it to end; close it so it starts at once.
    const running = execFileAsync(OPENCODE, ["run", ...runArgs], { cwd: project, env, timeout: 120_000 });
    running.child.stdin.end();
    const run = await running.catch((e) => e);
    return { project, seen, stdout: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  } finally {
    server.close();
  }
}

// In a headless run a rejected permission ends the whole subagent, so each forbidden command gets its own run.
const forbidden = [
  { name: "redirect", command: "git diff > leaked.txt", check: (project) => exists(join(project, "leaked.txt")).then((e) => assert.equal(e, false, "an allowlisted git command with a redirect must not write a file")) },
  { name: "output-flag", command: "git diff --output=leaked.txt", check: (project) => exists(join(project, "leaked.txt")).then((e) => assert.equal(e, false, "git diff --output must not write a file")) },
  { name: "rm", command: "rm victim.txt", check: (project) => exists(join(project, "victim.txt")).then((e) => assert.equal(e, true, "rm must not run")) },
];

for (const { name, command, check } of forbidden) {
  test(`the verifier agent is read-only: no edit tools, "git status --short" runs, \`${command}\` does not`, async () => {
    const mainScript = [{ tool: "task", args: { description: "verify the change", prompt: "Check that a.txt got a second line.", subagent_type: "verifier" } }];
    const verifierScript = [
      { tool: "bash", args: { command: "git status --short", description: "status" } },
      { tool: "bash", args: { command, description: "forbidden" } },
    ];
    const { project, seen, stdout } = await runOpencode(`readonly-${name}`, { mainScript, verifierScript, runArgs: ["go"] });
    const dump = () => `\n--- stdout ---\n${stdout}\n--- verifier ---\n${JSON.stringify(seen.verifier, null, 1)}`;

    assert.ok(seen.verifier.length >= 2, `the main agent started the verifier and it ran its script${dump()}`);
    const offered = seen.verifier[0].toolNames;
    for (const tool of ["edit", "write", "apply_patch", "webfetch", "websearch"]) {
      assert.ok(!offered.includes(tool), `the verifier is not offered "${tool}", got ${offered}${dump()}`);
    }
    assert.ok(offered.includes("read") && offered.includes("bash"), `it keeps read and bash, got ${offered}`);
    assert.match(seen.verifier[1].toolResults[0], /a\.txt/, `an allowlisted git call runs and returns its output${dump()}`);
    assert.match(stdout, /permission requested: bash/, `a command outside the allowlist asks for permission${dump()}`);
    await check(project).catch((e) => { e.message += dump(); throw e; });
  });
}

test("/verify starts a verifier subtask with the claim and the git evidence already in its prompt", async () => {
  const { seen, stdout } = await runOpencode("command", { runArgs: ["--command", "verify", "login must reject expired tokens"] });
  const dump = () => `\n--- stdout ---\n${stdout}\n--- verifier ---\n${JSON.stringify(seen.verifier, null, 1)}`;

  assert.ok(seen.verifier.length >= 1, `the command ran the verifier agent${dump()}`);
  const prompt = seen.verifier[0].firstUser;
  assert.match(prompt, /login must reject expired tokens/, `the claim reaches the verifier${dump()}`);
  assert.match(prompt, /M a\.txt/, `git status output is injected${dump()}`);
  assert.match(prompt, /\?\? new\.txt/, `untracked files show up in the status${dump()}`);
  assert.match(prompt, /\+two-changed-line/, `the diff is injected${dump()}`);
  assert.match(prompt, /init/, `recent commits are injected${dump()}`);
});
