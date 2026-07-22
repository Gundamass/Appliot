import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");

describe("production API artifact", () => {
  it("reaches the intentional dependency guard when launched", () => {
    const buildCommand = process.platform === "win32"
      ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "corepack pnpm run build"] }
      : { command: "corepack", args: ["pnpm", "run", "build"] };
    const build = spawnSync(buildCommand.command, buildCommand.args, {
      cwd: packageRoot,
      encoding: "utf8"
    });
    expect(build.status, build.stderr || build.stdout).toBe(0);

    const launch = spawnSync(process.execPath, ["dist/server.js"], {
      cwd: packageRoot,
      encoding: "utf8"
    });
    const output = `${launch.stdout}${launch.stderr}`;

    expect(launch.status).not.toBe(0);
    expect(output).toContain(
      "Local PDF and fact extraction dependencies must be configured before starting the API"
    );
    expect(output).not.toContain("ERR_MODULE_NOT_FOUND");
  });
});
