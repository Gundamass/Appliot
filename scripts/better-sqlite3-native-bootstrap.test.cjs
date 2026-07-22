const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, realpathSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const installedPackageDirectory = path.dirname(realpathSync(path.join(
  process.cwd(),
  "apps",
  "api",
  "node_modules",
  "better-sqlite3",
  "package.json"
)));
const bootstrap = require(path.join(installedPackageDirectory, "scripts", "resume-native-build.cjs"));

function makeWorkspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "resume-bootstrap-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "resume-application-assistant" }));
  return root;
}

test("finds the workspace root from a dependency package on POSIX", () => {
  const root = makeWorkspace();
  const dependency = path.join(root, "node_modules", ".pnpm", "better-sqlite3", "node_modules", "better-sqlite3");
  mkdirSync(dependency, { recursive: true });

  assert.equal(bootstrap.findWorkspaceRoot(dependency), root);
});

test("finds a workspace root through POSIX paths", () => {
  const root = "/workspace/resume-assistant";
  const packageFile = `${root}/package.json`;
  const workspaceFile = `${root}/pnpm-workspace.yaml`;

  assert.equal(bootstrap.findWorkspaceRoot(
    `${root}/node_modules/.pnpm/better-sqlite3/node_modules/better-sqlite3`,
    {
      paths: path.posix,
      exists: (file) => file === packageFile || file === workspaceFile,
      readFile: (file) => {
        assert.equal(file, packageFile);
        return JSON.stringify({ name: "resume-application-assistant" });
      }
    }
  ), root);
});

test("uses the dependency cwd when installation begins from a workspace child", () => {
  const root = makeWorkspace();
  const child = path.join(root, "apps", "api");
  const dependency = path.join(root, "node_modules", ".pnpm", "better-sqlite3", "node_modules", "better-sqlite3");
  mkdirSync(child, { recursive: true });
  mkdirSync(dependency, { recursive: true });
  const calls = [];

  const originalDirectory = process.cwd();
  const originalInitCwd = process.env.INIT_CWD;
  let result;
  try {
    process.chdir(dependency);
    process.env.INIT_CWD = child;
    result = bootstrap.runBootstrap({
      loadWrapper: (wrapperPath) => {
        calls.push(wrapperPath);
        return { runNativeBuild: (options) => options };
      }
    });
  } finally {
    process.chdir(originalDirectory);
    if (originalInitCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = originalInitCwd;
  }

  assert.equal(result.repositoryRoot, root);
  assert.equal(result.packageDirectory, dependency);
  assert.equal(calls[0], path.join(root, "scripts", "native-build-wrapper.cjs"));
});
