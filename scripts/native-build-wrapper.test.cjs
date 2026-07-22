const assert = require("node:assert/strict");
const test = require("node:test");
const { planNativeBuild, runNativeBuild } = require("./native-build-wrapper.cjs");

test("plans a Unicode repository root and package directory on an unused drive", () => {
  assert.deepEqual(planNativeBuild({
    platform: "win32",
    repositoryRoot: "E:\\projects\\resume helper\\resume assistant",
    packageDirectory: "E:\\projects\\resume helper\\resume assistant\\node_modules\\.pnpm\\better-sqlite3@11.10.0\\node_modules\\better-sqlite3",
    availableDrive: "R:"
  }), {
    nodeGypPath: "R:\\node_modules\\node-gyp\\bin\\node-gyp.js",
    packageDirectory: "R:\\node_modules\\.pnpm\\better-sqlite3@11.10.0\\node_modules\\better-sqlite3",
    repositoryRoot: "E:\\projects\\resume helper\\resume assistant",
    substDrive: "R:"
  });
});

test("keeps real paths on non-Windows platforms", () => {
  assert.deepEqual(planNativeBuild({
    platform: "linux",
    repositoryRoot: "/tmp/resume assistant",
    packageDirectory: "/tmp/resume assistant/node_modules/better-sqlite3",
    availableDrive: "R:"
  }), {
    nodeGypPath: "/tmp/resume assistant/node_modules/node-gyp/bin/node-gyp.js",
    packageDirectory: "/tmp/resume assistant/node_modules/better-sqlite3",
    repositoryRoot: "/tmp/resume assistant",
    substDrive: undefined
  });
});

test("rejects packages outside the repository root", () => {
  assert.throws(() => planNativeBuild({
    platform: "win32",
    repositoryRoot: "E:\\projects\\resume assistant",
    packageDirectory: "E:\\other\\better-sqlite3",
    availableDrive: "R:"
  }), /package directory must be inside repository root/);
});

test("cleans up a Windows drive mapping after the native build", () => {
  const calls = [];
  const result = runNativeBuild({
    platform: "win32",
    repositoryRoot: "E:\\projects\\resume assistant",
    packageDirectory: "E:\\projects\\resume assistant\\node_modules\\better-sqlite3",
    availableDrive: "R:",
    execute: (command, args, options) => {
      calls.push({ command, args, options });
      return 0;
    }
  });

  assert.equal(result, 0);
  assert.deepEqual(calls[0], { command: "subst", args: ["R:", "E:\\projects\\resume assistant"], options: undefined });
  assert.deepEqual(calls[2], { command: "subst", args: ["R:", "/d"], options: undefined });
});
