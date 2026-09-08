import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hostEnvironmentPrefixes = [/^VSCODE_/i, /^ELECTRON_/i, /^NODE_REPL_TRUSTED_/i];

export function sanitizePlaywrightEnvironment(environment) {
  const sanitized = { ...environment };
  for (const name of Object.keys(sanitized)) {
    if (hostEnvironmentPrefixes.some((prefix) => prefix.test(name))) delete sanitized[name];
  }
  if (sanitized.DEBUG === "release") delete sanitized.DEBUG;
  return sanitized;
}

export function normalizePlaywrightArgs(args) {
  return args[0] === "--" ? args.slice(1) : args;
}

export function runPlaywright(args, { environment = process.env, spawn = spawnSync } = {}) {
  const result = spawn(process.execPath, [
    "--import",
    "tsx",
    fileURLToPath(import.meta.resolve("@playwright/test/cli")),
    ...normalizePlaywrightArgs(args)
  ], {
    env: sanitizePlaywrightEnvironment(environment),
    shell: false,
    stdio: "inherit"
  });

  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runPlaywright(process.argv.slice(2));
}
