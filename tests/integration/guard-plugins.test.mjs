#!/usr/bin/env node
// Integration test for plugins/loop-guard, plugins/path-guard and plugins/council. Runs a real
// `opencode run` (OPENCODE_BIN, default `opencode`) with the plugins loaded from a throwaway
// project's .opencode/plugins/, and a fake local OpenAI-compatible server standing in for the model:
// it replays a scripted list of tool calls for the main agent, answers council seats and the
// synthesizer from their own system prompts, and records every request so the assertions can look at
// what the model was actually shown (tool results, which tools each agent was offered).
// This is what proves the hooks fire in the real tool pipeline, that mutating output.args really
// changes the call, and that the council's agents and permissions are registered through the config hook.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OPENCODE = process.env.OPENCODE_BIN ?? "opencode";

// council.ts imports zod, which only its own package directory provides.
await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], { cwd: join(REPO_ROOT, "plugins", "council"), shell: process.platform === "win32" });

const workDir = await mkdtemp(join(tmpdir(), "guard-plugins-test-"));
after(() => rm(workDir, { recursive: true, force: true }));

// The requests the fake model saw, and the script the main agent follows.
function startFakeProvider(script) {
  const seen = { main: [], seats: [], synth: [] };
  let step = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = JSON.parse(body);
      const text = (m) => (Array.isArray(m.content) ? m.content.map((x) => x.text ?? "").join("\n") : String(m.content ?? ""));
      const system = p.messages.filter((m) => m.role === "system").map(text).join("\n");
      const toolNames = (p.tools ?? []).map((t) => t.function.name);
      const lastUser = text(p.messages.filter((m) => m.role === "user").at(-1) ?? { content: "" });
      const toolResults = p.messages.filter((m) => m.role === "tool").map(text);

      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: p.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const say = (content) => {
        res.write(chunk({ role: "assistant", content }, null));
        res.write(chunk({}, "stop"));
        res.end("data: [DONE]\n\n");
      };

      if (system.includes("Your angle:")) {
        seen.seats.push({ system, toolNames, lastUser });
        const seat = system.includes("what is wrong") ? "skeptic" : system.includes("structure and long-term") ? "architect" : "pragmatist";
        return say(`SEAT-ANSWER(${seat})`);
      }
      if (system.includes("You combine the answers")) {
        seen.synth.push({ toolNames, lastUser });
        return say("CONSENSUS: majority\nANSWER: merged view\nDISAGREEMENTS: none");
      }
      if (toolNames.length === 0) return say("title"); // session title generation

      seen.main.push({ toolResults });
      const next = script[step++];
      if (!next) return say("all done");
      res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name: next.tool, arguments: JSON.stringify(next.args) } }] }, null));
      res.write(chunk({}, "tool_calls"));
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen })));
}

async function runOpencode(name, script, files = {}) {
  const home = join(workDir, name, "home");
  const project = join(workDir, name, "project");
  const { server, port, seen } = await startFakeProvider(script);
  try {
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await mkdir(join(project, ".opencode", "plugins"), { recursive: true });
    await writeFile(
      join(home, ".config", "opencode", "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "faketest/fake-model",
        provider: { faketest: { npm: "@ai-sdk/openai-compatible", name: "Fake", options: { baseURL: `http://127.0.0.1:${port}/v1` }, models: { "fake-model": { name: "Fake Model" } } } },
      }),
    );
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(project, rel)), { recursive: true });
      await writeFile(join(project, rel), content);
    }
    // Symlinked, so the plugin's own node_modules (council's zod) still resolves from its real location. Needs permission to create symlinks (on Windows, developer mode or an elevated shell).
    for (const plugin of ["loop-guard", "path-guard", "council"]) {
      await symlink(join(REPO_ROOT, "plugins", plugin, `${plugin}.ts`), join(project, ".opencode", "plugins", `${plugin}.ts`));
    }
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home, // os.homedir() reads USERPROFILE on Windows
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      // opencode takes its project directory from $PWD, not from the process's real cwd: left as the test runner's, it would load the repo's own config and treat the throwaway project as an external directory.
      PWD: project,
    };
    // `opencode run` reads piped stdin as part of the prompt and waits for it to end; close it so it starts at once.
    const running = execFileAsync(OPENCODE, ["run", "go"], { cwd: project, env, timeout: 120_000 });
    running.child.stdin.end();
    const run = await running.catch((e) => e);
    const sessions = await execFileAsync(OPENCODE, ["session", "list", "--format", "json"], { cwd: project, env, timeout: 60_000 }).then((r) => r.stdout, (e) => `ERR ${e.message}`);
    return { project, seen, stdout: `${run.stdout ?? ""}${run.stderr ?? ""}`, sessions };
  } finally {
    server.close();
  }
}

test("loop-guard and path-guard act inside the real tool pipeline", async () => {
  const project = join(workDir, "guards", "project");
  const real = (p) => join(project, p);
  // A guess that dropped the "guards" directory: workDir/project/... instead of workDir/guards/project/...
  const guessed = join(workDir, "project", "src", "mod", "b.txt");
  const same = { tool: "read", args: { filePath: real("src/mod/a.txt") } };
  const script = [
    { tool: "read", args: { filePath: real("src/mod/b.txt") } },
    { tool: "grep", args: { pattern: "x", path: real("nope") } },
    { tool: "read", args: { filePath: guessed } },
    same, same, same, same, same, same,
  ];
  const { seen, stdout } = await runOpencode("guards", script, { "src/mod/a.txt": "alpha-content", "src/mod/b.txt": "bravo-content" });
  const finalResults = seen.main.at(-1)?.toolResults ?? [];
  const dump = () => `\n--- stdout ---\n${stdout}\n--- tool results ---\n${JSON.stringify(finalResults, null, 1)}`;

  assert.equal(finalResults.length, 9, `the model should have seen 9 tool results${dump()}`);
  assert.match(finalResults[0], /bravo-content/, `a normal read is untouched${dump()}`);
  assert.match(finalResults[1], /the search path does not exist/, `grep with a missing path gets the guard's error${dump()}`);
  assert.match(finalResults[2], /bravo-content/, `a guessed path (workspace root dropped to its parent) is repaired before the read runs${dump()}`);
  assert.match(finalResults[3], /alpha-content/);
  assert.doesNotMatch(finalResults[3], /REPEATED TOOL CALL/);
  assert.doesNotMatch(finalResults[4], /REPEATED TOOL CALL/);
  assert.match(finalResults[5], /alpha-content[\s\S]*REPEATED TOOL CALL/, `the 3rd identical read carries the notice${dump()}`);
  assert.match(finalResults[7], /REPEATED TOOL CALL/);
  assert.match(finalResults[8], /Refusing to run "read"/, `the 6th identical read is refused${dump()}`);
});

test("council registers its agents, runs the seats with read-only tools and the synthesizer with none, and cleans up", async () => {
  const script = [{ tool: "council", args: { question: "Should we do X?", context: "see src/a.txt" } }];
  const { seen, stdout, sessions } = await runOpencode("council", script, { "src/a.txt": "x" });
  const dump = () => `\n--- stdout ---\n${stdout}\n--- seats ---\n${JSON.stringify(seen.seats.map((s) => s.toolNames))}`;

  assert.equal(seen.seats.length, 3, `three default seats were asked${dump()}`);
  for (const seat of seen.seats) {
    assert.ok(seat.toolNames.length > 0 && seat.toolNames.every((t) => ["read", "glob", "grep"].includes(t)), `a seat is offered only read-only tools, got ${seat.toolNames}${dump()}`);
    assert.match(seat.lastUser, /Should we do X\?[\s\S]*see src\/a\.txt/);
  }
  assert.equal(seen.synth.length, 1);
  assert.deepEqual(seen.synth[0].toolNames, [], "the synthesizer is offered no tools");
  assert.match(seen.synth[0].lastUser, /SEAT-ANSWER\(skeptic\)[\s\S]*SEAT-ANSWER\(architect\)[\s\S]*SEAT-ANSWER\(pragmatist\)/);

  const report = (seen.main.at(-1)?.toolResults ?? []).join("\n");
  assert.match(report, /Council report \(3 of 3 seats answered\)/, `the main agent received the report${dump()}`);
  assert.match(report, /CONSENSUS: majority/);
  assert.match(report, /### skeptic\nSEAT-ANSWER\(skeptic\)/);

  const listed = JSON.parse(sessions);
  assert.equal(listed.length, 1, `only the user's session remains, the seat and synthesis sessions are deleted: ${sessions}`);
});
