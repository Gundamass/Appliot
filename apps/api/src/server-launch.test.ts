import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(packageRoot, "../..");

describe("production API artifact", () => {
  it("builds without module resolution errors", () => {
    const buildCommand = process.platform === "win32"
      ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "corepack pnpm run build"] }
      : { command: "corepack", args: ["pnpm", "run", "build"] };
    const build = spawnSync(buildCommand.command, buildCommand.args, {
      cwd: packageRoot,
      encoding: "utf8"
    });
    expect(build.status, build.stderr || build.stdout).toBe(0);
  });
});
