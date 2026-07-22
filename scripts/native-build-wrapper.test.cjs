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

test("plans from POSIX paths without a drive mapping", () => {
  const plan = planNativeBuild({
    platform: "linux",
    repositoryRoot: "/workspace/resume assistant",
    packageDirectory: "/workspace/resume assistant/node_modules/.pnpm/better-sqlite3/node_modules/better-sqlite3"
  });

  assert.equal(plan.substDrive, undefined);
  assert.equal(plan.packageDirectory, "/workspace/resume assistant/node_modules/.pnpm/better-sqlite3/node_modules/better-sqlite3");
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

test("retries another available drive when mapping loses a race", () => {
  const calls = [];
  const result = runNativeBuild({
    platform: "win32",
    repositoryRoot: "E:\\projects\\resume assistant",
    packageDirectory: "E:\\projects\\resume assistant\\node_modules\\better-sqlite3",
    availableDrives: ["R:", "S:"],
    execute: (command, args) => {
      calls.push([command, args]);
      return args[1] === "E:\\projects\\resume assistant" && args[0] === "R:" ? 1 : 0;
    }
  });

  assert.equal(result, 0);
  assert.deepEqual(calls.map(([, args]) => args), [
    ["R:", "E:\\projects\\resume assistant"],
    ["S:", "E:\\projects\\resume assistant"],
    ["S:\\node_modules\\node-gyp\\bin\\node-gyp.js", "rebuild", "--release"],
    ["S:", "/d"]
  ]);
});

test("cleans up after a native build failure", () => {
  const calls = [];
  const result = runNativeBuild({
    platform: "win32",
    repositoryRoot: "E:\\projects\\resume assistant",
    packageDirectory: "E:\\projects\\resume assistant\\node_modules\\better-sqlite3",
    availableDrive: "R:",
    execute: (command, args) => {
      calls.push([command, args]);
      return command === process.execPath ? 2 : 0;
    }
  });

  assert.equal(result, 2);
  assert.deepEqual(calls.at(-1), ["subst", ["R:", "/d"]]);
});

test("fails explicitly when cleanup fails after a successful native build", () => {
  assert.throws(() => runNativeBuild({
    platform: "win32",
    repositoryRoot: "E:\\projects\\resume assistant",
    packageDirectory: "E:\\projects\\resume assistant\\node_modules\\better-sqlite3",
    availableDrive: "R:",
    execute: (command, args) => args[1] === "/d" ? 1 : 0
  }), /failed to remove temporary subst drive R:/);
});

test("adds cleanup context when subst cleanup throws", () => {
  assert.throws(() => runNativeBuild({
    platform: "win32",
    repositoryRoot: "E:\\projects\\resume assistant",
    packageDirectory: "E:\\projects\\resume assistant\\node_modules\\better-sqlite3",
    availableDrive: "R:",
    execute: (command, args) => {
      if (args[1] === "/d") throw new Error("access denied");
      return 0;
    }
  }), /failed to remove temporary subst drive R:.*access denied/);
});

test("preserves a build failure and reports a cleanup failure", () => {
  const errors = [];
  const result = runNativeBuild({
    platform: "win32",
    repositoryRoot: "E:\\projects\\resume assistant",
    packageDirectory: "E:\\projects\\resume assistant\\node_modules\\better-sqlite3",
    availableDrive: "R:",
    execute: (command, args) => {
      if (command === process.execPath) return 2;
      return args[1] === "/d" ? 1 : 0;
    },
    reportError: (message) => errors.push(message)
  });

  assert.equal(result, 2);
  assert.match(errors[0], /Native build exited with status 2/);
  assert.match(errors[0], /failed to remove temporary subst drive R:/);
});
