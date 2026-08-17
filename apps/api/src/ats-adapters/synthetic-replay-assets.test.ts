import { access } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const copyScript = fileURLToPath(new URL("../../../../scripts/copy-synthetic-ats-assets.mjs", import.meta.url));
const targetRoot = fileURLToPath(new URL("../../../../apps/api/dist/synthetic-ats-public/", import.meta.url));

describe("synthetic ATS build assets", () => {
  it("copies every runtime fixture into the API bundle directory", async () => {
    await execFile(process.execPath, [copyScript], { cwd: repositoryRoot });

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
      await expect(access(`${targetRoot}/${filename}`)).resolves.toBeUndefined();
    }
  });
});
