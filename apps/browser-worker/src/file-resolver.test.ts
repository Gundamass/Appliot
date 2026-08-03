import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUploadDirectoryResolver } from "./file-resolver.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true
  })));
});

describe("upload directory resolver", () => {
  it("resolves registered files inside the upload directory and rejects path traversal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "resume-upload-root-"));
    directories.push(directory);
    const filePath = join(directory, "resume-file-1.pdf");
    await writeFile(filePath, "%PDF-1.4", "utf8");
    const resolveFile = createUploadDirectoryResolver(directory);

    await expect(resolveFile("resume-file-1.pdf")).resolves.toBe(filePath);
    await expect(resolveFile("../secret.txt")).resolves.toBeUndefined();
    await expect(resolveFile("missing.pdf")).resolves.toBeUndefined();
  });
});
