// gitbash-edit-path-fix.ts is zero-runtime-dependency (only @opencode-ai/plugin's
// types, erased at build time) — no HOME redirection or npm install needed, unlike
// hook-logger/llm-review-gate.
//
// The hook itself only ever takes effect on `process.platform === "win32"`, but this
// sandbox's dev container is Linux (node:22-bookworm, see docker/Dockerfile) — it can
// never actually reach that branch. `withPlatform()` below temporarily overrides
// `process.platform` (a normal, configurable property on the real Node `process`
// object — this is not mocking a custom fake, it's flipping the same flag opencode's
// own source branches on) so the win32-only behavior can still be exercised here.
// This proves the plugin's *logic* is correct; it does not prove opencode's real
// Windows + Git Bash runtime honors it end to end — that needs an actual run on the
// offline target machine (see docs/deployment-environment.md), which this sandbox
// cannot reach. See TODO.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const { GitBashEditPathFix, toWindowsPath } = await import(
  "../../plugins/gitbash-edit-path-fix/gitbash-edit-path-fix.ts"
);

async function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    // `fn` is async — must `await` here, not `return fn()`, or `finally` below
    // restores `process.platform` as soon as `fn()` yields at its first internal
    // `await`, before its body actually resumes and reads the flipped platform.
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("toWindowsPath: converts each Git-Bash/Cygwin/WSL drive-rooted form", () => {
  assert.equal(toWindowsPath("/c/Users/franco/file.ts"), "C:/Users/franco/file.ts");
  assert.equal(toWindowsPath("/C/Users/franco/file.ts"), "C:/Users/franco/file.ts");
  assert.equal(toWindowsPath("/c:/Users/franco/file.ts"), "C:/Users/franco/file.ts");
  assert.equal(toWindowsPath("/cygdrive/c/Users/franco/file.ts"), "C:/Users/franco/file.ts");
  assert.equal(toWindowsPath("/mnt/c/Users/franco/file.ts"), "C:/Users/franco/file.ts");
  // bare drive root, no trailing segment
  assert.equal(toWindowsPath("/c"), "C:/");
});

test("toWindowsPath: leaves ordinary paths alone (returns undefined)", () => {
  assert.equal(toWindowsPath("C:/Users/franco/file.ts"), undefined);
  assert.equal(toWindowsPath("C:\\Users\\franco\\file.ts"), undefined);
  assert.equal(toWindowsPath("src/tool/edit.ts"), undefined);
  assert.equal(toWindowsPath("/home/franco/project/file.ts"), undefined);
  // "/cache/..." must not be mis-caught by the single-drive-letter pattern
  assert.equal(toWindowsPath("/cache/file.ts"), undefined);
});

test("hook: on win32, rewrites the edit tool's filePath in place", async () => {
  await withPlatform("win32", async () => {
    const hooks = await GitBashEditPathFix();
    const output = { args: { filePath: "/c/Users/franco/project/src/foo.ts", oldString: "a", newString: "b" } };
    const args = output.args; // same reference session/tools.ts's `args` variable would hold
    await hooks["tool.execute.before"]({ tool: "edit", sessionID: "s", callID: "c1" }, output);
    assert.equal(args.filePath, "C:/Users/franco/project/src/foo.ts");
    assert.equal(args.oldString, "a", "unrelated args must be untouched");
  });
});

test("hook: leaves an already-correct Windows path untouched", async () => {
  await withPlatform("win32", async () => {
    const hooks = await GitBashEditPathFix();
    const output = { args: { filePath: "C:/Users/franco/project/src/foo.ts" } };
    await hooks["tool.execute.before"]({ tool: "edit", sessionID: "s", callID: "c1" }, output);
    assert.equal(output.args.filePath, "C:/Users/franco/project/src/foo.ts");
  });
});

test("hook: ignores tools other than edit (e.g. write, bash)", async () => {
  await withPlatform("win32", async () => {
    const hooks = await GitBashEditPathFix();
    for (const tool of ["write", "bash", "apply_patch", "read"]) {
      const output = { args: { filePath: "/c/Users/franco/file.ts", command: "/c/Users/franco/file.ts" } };
      await hooks["tool.execute.before"]({ tool, sessionID: "s", callID: "c1" }, output);
      assert.equal(output.args.filePath, "/c/Users/franco/file.ts", `${tool} must be left alone (not in scope yet)`);
    }
  });
});

test("hook: no-ops entirely off win32 — documents this sandbox's real limitation", async () => {
  await withPlatform("linux", async () => {
    const hooks = await GitBashEditPathFix();
    const output = { args: { filePath: "/c/Users/franco/file.ts" } };
    await hooks["tool.execute.before"]({ tool: "edit", sessionID: "s", callID: "c1" }, output);
    assert.equal(output.args.filePath, "/c/Users/franco/file.ts", "must not rewrite on non-win32 platforms");
  });
});

test("hook: tolerates a missing or non-string filePath without throwing", async () => {
  await withPlatform("win32", async () => {
    const hooks = await GitBashEditPathFix();
    await assert.doesNotReject(() => hooks["tool.execute.before"]({ tool: "edit", sessionID: "s", callID: "c1" }, { args: {} }));
    await assert.doesNotReject(() =>
      hooks["tool.execute.before"]({ tool: "edit", sessionID: "s", callID: "c1" }, { args: { filePath: 123 } }),
    );
  });
});

// This is the real end-to-end proof, not just a test of our own function against
// our own assumptions: it reproduces the exact two lines opencode's real
// packages/opencode/src/tool/edit.ts uses to turn the model's `filePath` argument
// into the path it actually calls fs.stat/fs.readFile/fs.writeFile with —
//   const filePath = path.isAbsolute(params.filePath) ? params.filePath : path.join(instance.directory, params.filePath)
// — using Node's explicit `path.win32` (not the platform-dependent `path`), so the
// real Windows resolution behavior can be checked from this Linux sandbox without
// a Windows host. It runs that line with and without the plugin's hook applied
// first, and shows: unpatched, a Git-Bash-style absolute path resolves to a bogus
// path rooted on the wrong drive (never a real file); patched, it resolves to the
// file the model actually meant.
function editToolFilePathResolution(filePath, instanceDirectory) {
  return path.win32.isAbsolute(filePath) ? filePath : path.win32.join(instanceDirectory, filePath);
}

test("end-to-end: reproduces edit.ts's own path.isAbsolute branch — unpatched leaves an ambiguous driveless string, patched resolves correctly", async () => {
  const instanceDirectory = "D:\\Projects\\demo"; // the model's workspace lives on D:, not C:
  const modelGivenPath = "/c/Users/franco/project/src/foo.ts"; // what Git Bash reports as `pwd`/`readlink -f`

  const unpatched = editToolFilePathResolution(modelGivenPath, instanceDirectory);
  // edit.ts's ternary takes the "already absolute" branch here (path.win32.isAbsolute
  // treats a leading "/" as absolute-but-driveless) and returns the string completely
  // unchanged - it never calls path.resolve, so no drive gets attached at the JS layer
  // at all. This exact string is what then reaches fs.stat/fs.readFile/fs.writeFile.
  // What drive Windows actually substitutes for the missing one is decided by the OS/
  // libuv at the real filesystem call, not by any pure string function - not
  // reproducible here without a real Windows host - but the point stands either way:
  // it is never "C:", since nothing in this code path ever looked at the letter "c" in
  // "/c/...". On the real target machine this reads/writes whatever file happens to
  // sit at that path under the *current* drive instead of the file the model meant.
  assert.equal(unpatched, modelGivenPath, "edit.ts passes the Git-Bash path through completely unchanged");
  assert.equal(path.win32.isAbsolute(unpatched), true, "Node's own win32 path module still calls this absolute");

  await withPlatform("win32", async () => {
    const hooks = await GitBashEditPathFix();
    const args = { filePath: modelGivenPath };
    await hooks["tool.execute.before"]({ tool: "edit", sessionID: "s", callID: "c1" }, { args });
    const patched = editToolFilePathResolution(args.filePath, instanceDirectory);
    assert.equal(patched, "C:/Users/franco/project/src/foo.ts");
  });
});
