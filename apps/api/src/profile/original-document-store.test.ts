import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalOriginalDocumentStore } from "./original-document-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalOriginalDocumentStore", () => {
  it("retains exact bytes at a hash-owned local path and reuses them safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "resume-originals-"));
    roots.push(root);
    const store = createLocalOriginalDocumentStore(root);
    const bytes = Buffer.from("%PDF-exact original bytes");
    const fingerprint = createHash("sha256").update(bytes).digest("hex");

    const first = await store.retain(fingerprint, bytes);
    const second = await store.retain(fingerprint, Uint8Array.from(bytes));

    expect(first).toEqual({ path: join(root, `${fingerprint}.pdf`), created: true });
    expect(second).toEqual({ path: first.path, created: false });
    expect(await readFile(first.path)).toEqual(bytes);
  });
});
import { createHash } from "node:crypto";
