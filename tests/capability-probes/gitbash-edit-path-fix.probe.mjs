#!/usr/bin/env node
// Capability probe, not a pass/fail test - see tests/capability-probes/README.md.
//
// End to end on a real Windows kernel: does a real opencode `edit` call with a Git-Bash-style
// absolute path ("/c/Users/...") land on the intended file with plugins/gitbash-edit-path-fix
// loaded, and (control) does it fail without it? The plugin's unit tests only exercise the path
// helper and a stubbed hook; this drives the actual edit tool against the real filesystem.
//
// Windows only - the plugin deliberately no-ops elsewhere, so there is nothing to observe.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setupProbeEnv } from "./lib/harness.mjs";

if (process.platform !== "win32") {
  console.log("SKIPPED: the plugin only acts on win32, nothing to observe on this platform.");
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const pluginSource = await readFile(join(HERE, "..", "..", "plugins", "gitbash-edit-path-fix", "gitbash-edit-path-fix.ts"), "utf8");

// C:\Users\x\f.txt -> /c/Users/x/f.txt (what Git Bash reports)
const toGitBashPath = (winPath) => winPath.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replaceAll("\\", "/");

async function runCase(label, pluginFiles) {
  const env = await setupProbeEnv({
    pluginFiles,
    config: { permission: { edit: "allow", read: "allow", external_directory: "allow" } },
  });
  const dir = await mkdtemp(join(tmpdir(), "gitbash-edit-verify-"));
  const target = join(dir, "target.txt");
  await writeFile(target, "hello world\n");
  const gitBashPath = toGitBashPath(target);
  try {
    env.provider.setPlan([
      { toolCall: { id: "call_edit", name: "edit", args: { filePath: gitBashPath, oldString: "hello", newString: "HELLO" } } },
      { text: "done" },
    ]);
    const created = await env.client.session.create({ body: { title: `gitbash-edit:${label}` } });
    await Promise.race([
      env.client.session.prompt({ path: { id: created.data.id }, body: { parts: [{ type: "text", text: "please edit the file" }] } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("probe timeout after 30s")), 30_000)),
    ]);
    const parts = await env.transcript(created.data.id);
    const toolPart = parts.find((p) => p.type === "tool" && p.tool === "edit");
    const onDisk = await readFile(target, "utf8");
    return { label, gitBashPath, status: toolPart?.state.status, detail: toolPart?.state.error ?? toolPart?.state.output ?? null, onDisk };
  } finally {
    await env.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
}

const control = await runCase("control (no plugin)", {});
const patched = await runCase("with gitbash-edit-path-fix", { "gitbash-edit-path-fix.ts": pluginSource });

for (const r of [control, patched]) {
  console.log(`\n=== ${r.label} ===`);
  console.log(`filePath sent: ${r.gitBashPath}`);
  console.log(`edit tool state: ${r.status}`);
  console.log(`file on disk: ${JSON.stringify(r.onDisk)}`);
}

const controlBroken = !control.onDisk.startsWith("HELLO");
const patchedWorks = patched.onDisk.startsWith("HELLO world") && patched.status === "completed";
console.log(
  controlBroken
    ? "\nCONFIRMED: without the plugin, the Git-Bash-style path does not reach the intended file (the bug is real on this machine)."
    : "\nNOT CONFIRMED: without the plugin the edit still worked - this opencode version may have fixed the bug upstream.",
);
console.log(
  patchedWorks
    ? "CONFIRMED: with the plugin loaded, the real edit tool changed the intended file."
    : "NOT CONFIRMED: with the plugin loaded the intended file was not edited.",
);
process.exit(patchedWorks ? 0 : 1);
