// path-guard.ts: rescuePath is pure (path module and existence check are parameters), so the Windows flavor, the deployment target, runs here
// on Linux. The hook itself is driven against a real temporary directory.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";

const { PathGuard } = await import("../../plugins/path-guard/path-guard.ts");

// opencode treats every export of a plugin module as a plugin, so the pure repair function is not exported by the real file. The test
// imports a copy of it with one export appended instead; the copy has no imports besides erased types and node: modules, so it runs anywhere.
const scratch = await mkdtemp(join(tmpdir(), "path-guard-src-"));
await writeFile(join(scratch, "path-guard.ts"), `${await readFile(new URL("../../plugins/path-guard/path-guard.ts", import.meta.url), "utf-8")}\nexport { rescuePath };\n`);
const { rescuePath } = await import(pathToFileURL(join(scratch, "path-guard.ts")).href);
after(() => rm(scratch, { recursive: true, force: true }));

const existsIn = (...paths) => (p) => paths.includes(p);

test("posix: re-anchors a guess that dropped parent directories, keeping the whole tail", () => {
  const ws = "/w/Parent/Child/Project";
  assert.equal(rescuePath("/w/Project/src/a.ts", ws, path.posix, existsIn(`${ws}/src/a.ts`)), `${ws}/src/a.ts`);
  assert.equal(rescuePath("/w/Child/Project/src/a.ts", ws, path.posix, existsIn(`${ws}/src/a.ts`)), `${ws}/src/a.ts`, "the longest matching anchor wins");
});

test("posix: a guess that ends at the anchor maps to the workspace root", () => {
  const ws = "/w/Parent/Project";
  assert.equal(rescuePath("/w/Project", ws, path.posix, existsIn(ws)), ws);
});

test("posix: returns null whenever there is any doubt", () => {
  const ws = "/w/Parent/Project";
  const all = () => true;
  assert.equal(rescuePath("/w/Parent/Project/src/missing.ts", ws, path.posix, all), null, "already inside the workspace is a real absence");
  assert.equal(rescuePath(ws, ws, path.posix, all), null);
  assert.equal(rescuePath("/x/Project/a/Project/b.ts", ws, path.posix, all), null, "anchor occurs twice");
  assert.equal(rescuePath("/x/Project/../y.ts", ws, path.posix, all), null, "dot-dot segment");
  assert.equal(rescuePath("/x/Project/src/a.ts", ws, path.posix, existsIn()), null, "candidate does not exist: the tail is never trimmed");
  assert.equal(rescuePath("/x/unrelated/a.ts", ws, path.posix, all), null, "no anchor");
});

test("win32: handles backslashes, forward slashes and case-insensitive names", () => {
  const ws = "C:\\Users\\u\\Work\\Parent\\Child\\Project";
  const want = `${ws}\\src\\a.ts`;
  const exists = existsIn(want);
  assert.equal(rescuePath("C:\\Users\\u\\Work\\Project\\src\\a.ts", ws, path.win32, exists), want);
  assert.equal(rescuePath("C:/Users/u/Work/Project/src/a.ts", ws, path.win32, exists), want);
  assert.equal(rescuePath("C:\\Users\\u\\Work\\PROJECT\\src\\a.ts", ws, path.win32, exists), want);
  assert.equal(rescuePath("C:\\Users\\u\\Work\\Parent\\Child\\Project\\src\\a.ts", ws, path.win32, () => true), null, "inside the workspace");
});

const root = await realpath(await mkdtemp(join(tmpdir(), "path-guard-test-")));
const workspace = join(root, "Parent", "Child", "Project");
await mkdir(join(workspace, "src"), { recursive: true });
await writeFile(join(workspace, "src", "a.ts"), "x");
after(() => rm(root, { recursive: true, force: true }));

const run = async (tool, args) => {
  const hooks = await PathGuard({ directory: workspace });
  const output = { args };
  await hooks["tool.execute.before"]({ tool, sessionID: "s", callID: "c" }, output);
  return output.args;
};

test("hook: rewrites a guessed absolute path in place, for read and for search tools", async () => {
  const guess = join(root, "Parent", "Project", "src", "a.ts"); // no Child segment
  assert.equal((await run("read", { filePath: guess })).filePath, join(workspace, "src", "a.ts"));
  const dir = join(root, "Parent", "Project", "src");
  assert.equal((await run("grep", { pattern: "x", path: dir })).path, join(workspace, "src"));
  assert.equal((await run("glob", { pattern: "*", path: dir })).path, join(workspace, "src"));
});

test("hook: leaves existing paths, relative paths and a missing read target alone", async () => {
  assert.deepEqual(await run("read", { filePath: join(workspace, "src", "a.ts") }), { filePath: join(workspace, "src", "a.ts") });
  assert.deepEqual(await run("grep", { pattern: "x", path: "src" }), { pattern: "x", path: "src" });
  assert.deepEqual(await run("grep", { pattern: "x" }), { pattern: "x" }, "no path means the workspace");
  const missing = join(workspace, "src", "nope.ts");
  assert.deepEqual(await run("read", { filePath: missing }), { filePath: missing }, "read already reports this clearly");
});

test("hook: grep and glob get a clear error for a search path that does not exist", async () => {
  await assert.rejects(() => run("grep", { pattern: "x", path: join(workspace, "nope") }), /grep: the search path does not exist: .*nope/);
  await assert.rejects(() => run("glob", { pattern: "*", path: "nope" }), /glob: the search path does not exist: .*nope/);
});

test("hook: ignores other tools and missing args", async () => {
  assert.deepEqual(await run("bash", { command: "ls", path: "/nonexistent" }), { command: "ls", path: "/nonexistent" });
  const hooks = await PathGuard({ directory: workspace });
  await assert.doesNotReject(() => hooks["tool.execute.before"]({ tool: "grep", sessionID: "s", callID: "c" }, {}));
});
