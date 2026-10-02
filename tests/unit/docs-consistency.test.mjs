// Static checks that the docs still describe the repo as it is. Plain file
// reads, no opencode install needed. Each check compares a doc against the
// real thing it describes (the directory tree, release.yml, the example
// config), never one doc against another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(repoRoot, p), "utf-8");

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "vendor", "opencode-docs-reference", ".local"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function subdirs(parent) {
  return readdirSync(join(repoRoot, parent))
    .filter((n) => statSync(join(repoRoot, parent, n)).isDirectory() && !SKIP_DIRS.has(n))
    .sort();
}

// Rows of the first markdown table in `file`, as arrays of trimmed cells.
function tableRows(file) {
  return read(file)
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^-+$/.test(c)))
    .slice(1);
}

const rowName = (cell) => /^\[?`?([a-z0-9-]+)`?\]/.exec(cell)?.[1];

test("every relative markdown link in the repo's own docs resolves", () => {
  const broken = [];
  for (const file of walk(repoRoot).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(file, "utf-8").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      if (!existsSync(resolve(dirname(file), target))) broken.push(`${relative(repoRoot, file)} -> ${m[1]}`);
    }
  }
  assert.deepEqual(broken, []);
});

for (const parent of ["plugins", "mcp-servers"]) {
  test(`${parent}/README.md lists exactly the directories under ${parent}/, each with its own README`, () => {
    const listed = tableRows(`${parent}/README.md`).map((r) => rowName(r[0])).sort();
    assert.deepEqual(listed, subdirs(parent));
    for (const name of subdirs(parent)) {
      assert.ok(existsSync(join(repoRoot, parent, name, "README.md")), `${parent}/${name}/README.md`);
    }
  });
}

// release.yml's `for dir in ...` loop is the source of truth for what is published.
function publishedDirs() {
  const loop = /for dir in ([^;]+); do/.exec(read(".github/workflows/release.yml"));
  assert.ok(loop, "release.yml package loop not found");
  return loop[1].trim().split(/\s+/);
}

test("plugins/README.md 'Published' column matches release.yml's package loop", () => {
  const published = new Set(publishedDirs());
  for (const row of tableRows("plugins/README.md")) {
    const name = rowName(row[0]);
    const claims = row[3].startsWith("yes");
    assert.equal(published.has(`plugins/${name}`), claims, `plugins/${name}: README says "${row[3]}"`);
  }
});

test("every mcp-servers directory with its own code is in release.yml's package loop, and the others are not", () => {
  const published = new Set(publishedDirs());
  for (const row of tableRows("mcp-servers/README.md")) {
    const name = rowName(row[0]);
    assert.equal(published.has(`mcp-servers/${name}`), row[2] === "ours", `mcp-servers/${name}: code is "${row[2]}"`);
  }
});

test("'In deploy/opencode.json.example' columns match the example config", () => {
  const raw = read("deploy/opencode.json.example");
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));

  for (const row of tableRows("mcp-servers/README.md")) {
    const name = rowName(row[0]);
    const entry = config.mcp?.[name];
    const actual = entry ? (entry.enabled ? "enabled" : "disabled") : "not wired";
    assert.equal(row[4], actual, `mcp.${name}`);
    if (entry) assert.equal(row[3], entry.type, `mcp.${name}.type`);
  }

  for (const row of tableRows("plugins/README.md")) {
    const name = rowName(row[0]);
    const pkg = `"@kealthas-dev/opencode-${name}"`;
    const active = raw.split("\n").some((l) => l.includes(pkg) && !l.trim().startsWith("//"));
    const commented = raw.split("\n").some((l) => l.includes(pkg) && l.trim().startsWith("//"));
    const actual = active ? "enabled" : commented ? "commented out (opt-in)" : "no";
    assert.equal(row[2], actual, `plugin ${name}`);
  }
});
