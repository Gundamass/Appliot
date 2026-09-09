import { access, rm } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const copyScript = fileURLToPath(new URL("../../../../scripts/copy-synthetic-ats-assets.mjs", import.meta.url));

describe("synthetic ATS build assets", () => {
  it("copies every runtime fixture into the API bundle directory", async () => {
    const targetRoot = resolve(repositoryRoot, "apps/api/dist", `synthetic-ats-test-${randomUUID()}`);
    try {
      await execFile(process.execPath, [copyScript], {
        cwd: repositoryRoot,
        env: { ...process.env, SYNTHETIC_ATS_ASSET_TARGET: targetRoot }
      });

      for (const filename of [
        "application.html",
        "review.html",
        "stability.html",
        "runtime-p0.html",
        "challenge-p0.html",
        "job-list.html",
        "adapter-replay-basic.html",
        "adapter-replay-boundary.html",
        "adapter-replay-repeated.html"
      ]) {
        await expect(access(resolve(targetRoot, filename))).resolves.toBeUndefined();
      }
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("copies assets to an isolated target selected by the caller", async () => {
    const isolatedTarget = resolve(repositoryRoot, "apps/api/dist", `synthetic-ats-test-${randomUUID()}`);
    try {
      await execFile(process.execPath, [copyScript], {
        cwd: repositoryRoot,
        env: { ...process.env, SYNTHETIC_ATS_ASSET_TARGET: isolatedTarget }
      });

      await expect(access(resolve(isolatedTarget, "application.html"))).resolves.toBeUndefined();
    } finally {
      await rm(isolatedTarget, { recursive: true, force: true });
    }
  });
});
