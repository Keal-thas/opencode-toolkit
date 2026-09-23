#!/usr/bin/env node
// Integration test for toolkits/module-analysis/analyze-modules.ts. Runs the real
// driver (via its local tsx devDependency, same as the driver's own "npm
// start" script - see its package.json) against a real opencode server (the
// SDK's createOpencode() spawns the actual `opencode` binary), with a fake
// local OpenAI-compatible HTTP server standing in for the model provider -
// so it's still fast/deterministic/no-network, just faking the model call
// instead of the whole CLI the way the old bash version's stub-bin did.
// Covers: happy path (per-module output written from the agent's captured
// answer), a failed module leaving no output but a captured log, and the
// resumability/skip logic (a module with an existing non-empty output file
// must never be re-invoked).
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function isNonEmptyFile(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

// Stands in for the real vLLM + Qwen endpoint: an OpenAI-compatible chat
// completions server that replies based on which module's prompt it
// received, and records how many times each module was hit (so the
// resumability/skip assertion can confirm moduleD's prompt never went out
// over the wire, not just that no log file happened to be written for it).
function startFakeProvider() {
  const hits = { moduleA: 0, moduleB: 0, moduleC: 0, moduleD: 0 };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const lastUserText = parsed.messages
        .filter((m) => m.role === "user")
        .flatMap((m) => (Array.isArray(m.content) ? m.content.map((p) => p.text ?? "") : [m.content]))
        .join("\n");

      const moduleName = Object.keys(hits).find((name) => lastUserText.includes(`/${name}`));
      if (moduleName) hits[moduleName]++;

      if (moduleName === "moduleC") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "simulated failure for moduleC", type: "invalid_request_error" } }));
        return;
      }

      const text = moduleName ? `${moduleName} analysis result` : "unrecognized module in test stub";
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: parsed.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: text }, null));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, hits }));
  });
}

const workDir = await mkdtemp(join(tmpdir(), "analyze-modules-test-"));
const { server: fakeProvider, port, hits } = await startFakeProvider();

try {
  const modulesDir = join(workDir, "modules");
  const outDir = join(workDir, "out");
  const logDir = join(workDir, "logs");
  for (const name of ["moduleA", "moduleB", "moduleC", "moduleD"]) {
    await mkdir(join(modulesDir, name), { recursive: true });
  }
  await mkdir(outDir, { recursive: true });

  // moduleD is already analyzed - the resumable/skip path must leave it
  // untouched and must never even send its prompt to the fake provider.
  await writeFile(join(outDir, "moduleD.md"), "SENTINEL - already done");

  // Throwaway HOME so this never touches a real dev session's opencode
  // config, mirroring docker-prompt-override.test.sh's approach - and so
  // createOpencode() resolves this fake provider instead of whatever a real
  // opencode.json on the machine running the test might configure.
  const fakeHome = join(workDir, "home");
  await mkdir(join(fakeHome, ".config", "opencode"), { recursive: true });
  await writeFile(
    join(fakeHome, ".config", "opencode", "opencode.jsonc"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "faketest/fake-model",
      provider: {
        faketest: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fake Test Provider",
          options: { baseURL: `http://127.0.0.1:${port}/v1` },
          models: { "fake-model": { name: "Fake Model" } },
        },
      },
    }),
  );

  const fail = [];

  try {
    const moduleAnalysisDir = join(REPO_ROOT, "toolkits", "module-analysis");
    // Local tsx devDependency, not a global install - resolved the same way
    // `npm start` would resolve it, so this exercises the exact binary a
    // real invocation uses.
    const tsxBin = join(moduleAnalysisDir, "node_modules", ".bin", "tsx");
    await execFileAsync(tsxBin, ["analyze-modules.ts"], {
      cwd: moduleAnalysisDir,
      env: {
        ...process.env,
        HOME: fakeHome,
        MODULES_DIR: modulesDir,
        OUT_DIR: outDir,
        LOG_DIR: logDir,
        CONCURRENCY: "2",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      },
      timeout: 60_000,
    });
  } catch (err) {
    fail.push(`driver run failed: ${err.message}\n--- stdout/stderr ---\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  }

  async function assertFileContains(path, needle) {
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch {
      fail.push(`expected file to exist: ${path}`);
      return;
    }
    if (!content.includes(needle)) fail.push(`expected ${path} to contain: ${needle}`);
  }

  // Happy path: each module's captured text answer lands in its own file.
  await assertFileContains(join(outDir, "moduleA.md"), "moduleA analysis result");
  await assertFileContains(join(outDir, "moduleB.md"), "moduleB analysis result");
  if (hits.moduleA !== 1) fail.push(`expected exactly 1 request for moduleA, got ${hits.moduleA}`);
  if (hits.moduleB !== 1) fail.push(`expected exactly 1 request for moduleB, got ${hits.moduleB}`);

  // Failure path: a failed generation must leave no (or empty) output, but
  // the log file should still capture the error for later inspection.
  if (await isNonEmptyFile(join(outDir, "moduleC.md"))) {
    fail.push("moduleC.md should be empty/absent after a simulated provider failure");
  }
  await assertFileContains(join(logDir, "moduleC.log"), "simulated failure for moduleC");
  if (hits.moduleC !== 1) fail.push(`expected exactly 1 request for moduleC, got ${hits.moduleC}`);

  // Resumability: a module with an existing non-empty output file must be
  // skipped entirely - untouched content, and no request sent for it at all.
  const moduleDContent = await readFile(join(outDir, "moduleD.md"), "utf8");
  if (moduleDContent !== "SENTINEL - already done") {
    fail.push("moduleD.md was overwritten even though it was already analyzed");
  }
  if (hits.moduleD !== 0) fail.push(`expected moduleD to never be requested, got ${hits.moduleD} request(s)`);

  if (fail.length === 0) {
    console.log("PASS: analyze-modules.ts integration test");
    process.exitCode = 0;
  } else {
    for (const line of fail) console.error(`FAIL: ${line}`);
    process.exitCode = 1;
  }
} finally {
  fakeProvider.close();
  await rm(workDir, { recursive: true, force: true });
}
