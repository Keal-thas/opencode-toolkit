// The v* tag is the only source of truth for the version every npm package is
// published at, so every package.json carries the 0.0.0 sentinel instead of a
// real version literal. release.yml overwrites it with the tag's version right
// before `npm publish`. A real version in a package.json is what used to drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(repoRoot, p), "utf-8");

const workflow = read(".github/workflows/release.yml");

// The loop's own list is the definition of "every package published together".
function releaseDirs() {
  const line = workflow.split("\n").find((l) => l.includes("for dir in "));
  assert.ok(line, "release.yml has no `for dir in` loop");
  return line
    .split("for dir in ")[1]
    .split(";")[0]
    .trim()
    .split(/\s+/);
}

const dirs = releaseDirs();

test("release.yml lists every published package directory", () => {
  assert.ok(dirs.length >= 11, `only ${dirs.length} package dirs in release.yml`);
  for (const dir of dirs) {
    assert.ok(existsSync(join(repoRoot, dir, "package.json")), `${dir}/package.json is missing`);
  }
});

test("release.yml still takes the version from the tag", () => {
  assert.match(workflow, /VERSION="\$\{GITHUB_REF_NAME#v\}"/);
  assert.match(workflow, /npm pkg set version="\$VERSION"/);
});

test("every package.json uses the 0.0.0 sentinel", () => {
  for (const dir of dirs) {
    const pkg = JSON.parse(read(join(dir, "package.json")));
    assert.equal(pkg.version, "0.0.0", `${dir}/package.json: leave version at 0.0.0, the tag sets the real one`);
  }
});
