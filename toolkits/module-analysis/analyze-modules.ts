// Unattended, concurrency-limited, resumable per-module analysis runner.
//
// Iterates every immediate subdirectory of MODULES_DIR, and for each one
// sends one prompt to a single shared opencode server (via @opencode-ai/sdk)
// with the `plan` agent (edit/write tools permission-denied), to produce a
// module-analysis doc. The analysis prompt comes from prompt-template.md in
// this same directory (single source of truth, no duplicated copy):
// @@MODULES_ROOT@@ is substituted once here, and @@MODULE_PATH@@ per module
// below.
// The agent can't write the doc itself (that's the point), so this script
// takes its final answer straight from the SDK's typed response and writes
// it to the output file itself. Safe to interrupt and re-run: any module
// that already has a non-empty output file is skipped.
//
// Usage:
//   cd toolkits/module-analysis && npm install   # once, pulls in @opencode-ai/sdk
//   MODULES_DIR=/path/to/project/src/modules \
//   OUT_DIR=/path/to/project/docs/module-analysis \
//   npm start
//
// Tune CONCURRENCY down if the shared vLLM server starts queuing/slowing
// down under load; there's no hard reason to keep it low otherwise since
// total wall time isn't a constraint (each module run is independent). All
// concurrent runs share the one opencode server this script starts, so
// raising CONCURRENCY costs no extra server start-up overhead.

import { createOpencode, type OpencodeClient, type Part } from "@opencode-ai/sdk";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`error: set ${name} to ${hint}`);
    process.exit(1);
  }
  return value;
}

const MODULES_DIR = requireEnv("MODULES_DIR", "the directory containing one subdirectory per module");
const OUT_DIR = requireEnv("OUT_DIR", "where the analysis .md files should be written");
const LOG_DIR = process.env.LOG_DIR || join(OUT_DIR, "..", "logs", "module-analysis");
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
// plan: a primary agent with edit/write tools permission-denied - confirmed
// live via client.app.agents() (its permission list carries an explicit
// {permission:"edit", pattern:"*", action:"deny"} entry), so this holds even
// against a model that's been tricked by hostile content in the analyzed
// code. explore fits the "read-only" framing better by name, and - unlike
// the `opencode` CLI, which silently falls back to the full-access `build`
// agent for `run --agent explore` since explore is a subagent-only role -
// the SDK's session.prompt() can actually target it directly (confirmed
// live: the response's info.mode/info.agent came back "explore", and the
// model's own reasoning referenced its real "read-only file search
// specialist" identity, not build's). But explore's read-only behavior
// turned out to be enforced only by its own system prompt ("Do not create
// any files, or run bash commands that modify the user's system state") -
// its permission list has no edit-deny entry at all, just a blanket allow.
// That's weaker than plan's hard permission-layer denial for a tool meant
// to run unattended over arbitrary, possibly hostile, third-party code, so
// plan stays the default despite explore now being directly reachable.
const AGENT = process.env.AGENT || "plan";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RAW_TEMPLATE = await readFile(join(SCRIPT_DIR, "prompt-template.md"), "utf8");
if (!RAW_TEMPLATE.includes("@@MODULE_PATH@@") || !RAW_TEMPLATE.includes("@@MODULES_ROOT@@")) {
  console.error("error: prompt-template.md must contain both @@MODULE_PATH@@ and @@MODULES_ROOT@@ placeholders");
  process.exit(1);
}
// @@...@@ tokens instead of {{}}: kept from the original bash implementation
// so prompt-template.md doesn't need to change - no bash-specific reason
// applies anymore, but there's no reason to churn the template either.
const PROMPT_TEMPLATE = RAW_TEMPLATE.replaceAll("@@MODULES_ROOT@@", MODULES_DIR);

await mkdir(OUT_DIR, { recursive: true });
await mkdir(LOG_DIR, { recursive: true });

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

function lastTextPart(parts: Part[]): string | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type === "text") return part.text;
  }
  return undefined;
}

async function analyzeOne(client: OpencodeClient, moduleDir: string): Promise<void> {
  const moduleName = basename(moduleDir);
  const outFile = join(OUT_DIR, `${moduleName}.md`);
  const logFile = join(LOG_DIR, `${moduleName}.log`);

  if (await isNonEmptyFile(outFile)) {
    console.log(`[skip] ${moduleName} already analyzed`);
    return;
  }

  const prompt = PROMPT_TEMPLATE.replaceAll("@@MODULE_PATH@@", moduleDir);
  console.log(`[start] ${moduleName}`);

  let result;
  try {
    const session = await client.session.create({ body: { title: `module-analysis: ${moduleName}` } });
    // model is deliberately omitted - falls back to whatever default model
    // the target opencode.json already configures (the vLLM + Qwen setup),
    // matching the old `opencode run` invocation, which never passed --model
    // either.
    result = await client.session.prompt({
      path: { id: session.data!.id },
      body: { agent: AGENT, parts: [{ type: "text", text: prompt }] },
    });
  } catch (err) {
    await writeFile(logFile, `request failed: ${(err as Error).name}: ${(err as Error).message}\n`);
    console.log(`[FAIL] ${moduleName} (see ${logFile})`);
    return;
  }

  // A failed generation (e.g. the provider erroring out after retries)
  // doesn't reject the promise above - it resolves with an empty parts list
  // and the failure recorded on info.error instead. A malformed request
  // (e.g. an unknown model) resolves with no `data` at all and a top-level
  // `error`. Handle both the same way: no text means no output file.
  const text = result.data ? lastTextPart(result.data.parts) : undefined;
  await writeFile(
    logFile,
    JSON.stringify({ error: result.error ?? result.data?.info?.error ?? null, info: result.data?.info }, null, 2),
  );

  if (text) {
    await writeFile(outFile, text);
    console.log(`[done] ${moduleName}`);
  } else {
    console.log(`[FAIL] ${moduleName} (see ${logFile})`);
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

const moduleDirs = (await readdir(MODULES_DIR, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(MODULES_DIR, entry.name));

const { client, server } = await createOpencode();
try {
  await runWithConcurrency(moduleDirs, CONCURRENCY, (moduleDir) => analyzeOne(client, moduleDir));
} finally {
  server.close();
}

const doneCount = (
  await Promise.all(moduleDirs.map((dir) => isNonEmptyFile(join(OUT_DIR, `${basename(dir)}.md`))))
).filter(Boolean).length;
console.log(`进度: ${doneCount} / ${moduleDirs.length}，结果在 ${OUT_DIR}`);
