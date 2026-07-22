const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function planNativeBuild({ platform, repositoryRoot, packageDirectory, availableDrive }) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const relativePackageDirectory = paths.relative(repositoryRoot, packageDirectory);
  if (relativePackageDirectory === "" || relativePackageDirectory.startsWith("..") || paths.isAbsolute(relativePackageDirectory)) {
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

function findUnusedDrives() {
  const availableDrives = [];
  for (let code = "Z".charCodeAt(0); code >= "R".charCodeAt(0); code -= 1) {
    const drive = `${String.fromCharCode(code)}:`;
    if (!existsSync(`${drive}\\`)) availableDrives.push(drive);
  }
  if (availableDrives.length === 0) throw new Error("no unused drive letter is available for native build");
  return availableDrives;
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function cleanupFailure(drive, status) {
  return new Error(`failed to remove temporary subst drive ${drive} (exit ${status})`);
}

function runNativeBuild({
  platform = process.platform,
  repositoryRoot,
  packageDirectory,
  availableDrive,
  availableDrives = platform === "win32" ? findUnusedDrives() : undefined,
  execute = run,
  reportError = console.error
}) {
  if (platform !== "win32") {
    const plan = planNativeBuild({ platform, repositoryRoot, packageDirectory });
    return execute(process.execPath, [plan.nodeGypPath, "rebuild", "--release"], { cwd: plan.packageDirectory });
  }

  const drives = availableDrive ? [availableDrive] : availableDrives;
  for (const drive of drives) {
    const plan = planNativeBuild({ platform, repositoryRoot, packageDirectory, availableDrive: drive });
    if (execute("subst", [plan.substDrive, plan.repositoryRoot]) !== 0) continue;

    let buildStatus;
    let buildError;
    try {
      buildStatus = execute(process.execPath, [plan.nodeGypPath, "rebuild", "--release"], { cwd: plan.packageDirectory });
    } catch (error) {
      buildError = error;
    }

    let cleanupError;
    try {
      const cleanupStatus = execute("subst", [plan.substDrive, "/d"]);
      if (cleanupStatus !== 0) cleanupError = cleanupFailure(plan.substDrive, cleanupStatus);
    } catch (error) {
      cleanupError = new Error(`failed to remove temporary subst drive ${plan.substDrive}: ${error.message}`);
    }

    if (cleanupError) {
      if (buildError) {
        reportError(`Native build failed: ${buildError.message}; additionally ${cleanupError.message}`);
        throw buildError;
      }
      if (buildStatus !== 0) {
        reportError(`Native build exited with status ${buildStatus}; additionally ${cleanupError.message}`);
        return buildStatus;
      }
      throw cleanupError;
    }

    if (buildError) throw buildError;
    return buildStatus;
  }

  throw new Error("failed to map an available temporary subst drive for native build");
}

module.exports = { findUnusedDrives, planNativeBuild, runNativeBuild };

if (require.main === module) {
  const [repositoryRoot, packageDirectory] = process.argv.slice(2);
  if (!repositoryRoot || !packageDirectory) {
    throw new Error("usage: native-build-wrapper <repository-root> <package-directory>");
  }
  process.exitCode = runNativeBuild({ repositoryRoot, packageDirectory });
}
