const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function planNativeBuild({ platform, repositoryRoot, packageDirectory, availableDrive }) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const relativePackageDirectory = paths.relative(repositoryRoot, packageDirectory);
  if (relativePackageDirectory === "" || relativePackageDirectory.startsWith("..") || path.isAbsolute(relativePackageDirectory)) {
    throw new Error("package directory must be inside repository root");
  }

  if (platform !== "win32") {
    return {
      repositoryRoot,
      packageDirectory,
      nodeGypPath: paths.join(repositoryRoot, "node_modules", "node-gyp", "bin", "node-gyp.js"),
      substDrive: undefined
    };
  }

  return {
    repositoryRoot,
    packageDirectory: path.win32.join(`${availableDrive}\\`, relativePackageDirectory),
    nodeGypPath: path.win32.join(`${availableDrive}\\`, "node_modules", "node-gyp", "bin", "node-gyp.js"),
    substDrive: availableDrive
  };
}

function findUnusedDrive() {
  for (let code = "Z".charCodeAt(0); code >= "R".charCodeAt(0); code -= 1) {
    const drive = `${String.fromCharCode(code)}:`;
    if (!existsSync(`${drive}\\`)) return drive;
  }
  throw new Error("no unused drive letter is available for native build");
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function runNativeBuild({ platform = process.platform, repositoryRoot, packageDirectory, availableDrive = findUnusedDrive(), execute = run }) {
  const plan = planNativeBuild({ platform, repositoryRoot, packageDirectory, availableDrive });
  if (!plan.substDrive) {
    return execute(process.execPath, [plan.nodeGypPath, "rebuild", "--release"], { cwd: plan.packageDirectory });
  }

  let mapped = false;
  try {
    if (execute("subst", [plan.substDrive, plan.repositoryRoot]) !== 0) return 1;
    mapped = true;
    return execute(process.execPath, [plan.nodeGypPath, "rebuild", "--release"], { cwd: plan.packageDirectory });
  } finally {
    if (mapped) execute("subst", [plan.substDrive, "/d"]);
  }
}

module.exports = { planNativeBuild, runNativeBuild };

if (require.main === module) {
  const [repositoryRoot, packageDirectory] = process.argv.slice(2);
  if (!repositoryRoot || !packageDirectory) {
    throw new Error("usage: native-build-wrapper <repository-root> <package-directory>");
  }
  process.exitCode = runNativeBuild({ repositoryRoot, packageDirectory });
}
