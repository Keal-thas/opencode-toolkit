// Cheap regression net: every shipped shell script must at least parse.
// Catches things like an unbalanced heredoc or quote slipping into
// entrypoint.sh or the docs-fetch script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// docs/opencode-docs-reference is a large vendored mirror of upstream docs,
// not this repo's own code - out of scope here (and for this repo's tests
// in general, per project convention).
const EXCLUDED_DIR_PREFIXES = ["docs/opencode-docs-reference", ".git"];

async function findShellScripts(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(repoRoot, full);
    if (EXCLUDED_DIR_PREFIXES.some((p) => rel === p || rel.startsWith(p + "/"))) continue;
    if (entry.isDirectory()) {
      found.push(...(await findShellScripts(full)));
    } else if (entry.isFile() && entry.name.endsWith(".sh")) {
      found.push(full);
    }
  }
  return found;
}

test("every .sh script in the repo passes `bash -n` (syntax check only, nothing executed)", async () => {
  const scripts = await findShellScripts(repoRoot);
  assert.ok(scripts.length > 0, "expected to find at least one shell script");

  const failures = [];
  for (const script of scripts) {
    try {
      await execFileAsync("bash", ["-n", script]);
    } catch (e) {
      failures.push(`${relative(repoRoot, script)}: ${e.stderr || e.message}`);
    }
  }
  assert.deepEqual(failures, []);
});
