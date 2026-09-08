import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createProfileRepository } from "./profile-repository.js";
import { createLocalOriginalDocumentStore } from "./original-document-store.js";
import { retainCurrentProfileDocument } from "./current-document-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("retainCurrentProfileDocument", () => {
  it("updates the current PDF without extraction or profile writes and reuses duplicates", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const root = await mkdtemp(join(tmpdir(), "resume-current-"));
    roots.push(root);
    const bytes = Buffer.from("%PDF-current resume");
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    const profileRepository = createProfileRepository(database);
    profileRepository.upsertUserFact({ fieldPath: "basics.name", value: "何庆" });
    const beforeFacts = profileRepository.listActive();
    const extractPdf = vi.fn();
    const extractFacts = vi.fn();
    const dependencies = {
      database,
      profileRepository,
      originalDocumentStore: createLocalOriginalDocumentStore(root),
      extractPdf,
      extractFacts
    };

    const retained = await retainCurrentProfileDocument(dependencies, "new.pdf", bytes);
    expect(retained).toMatchObject({ filename: "new.pdf", fingerprint, importStatus: "retained", isCurrent: true });
    expect(await readFile(retained.sourcePath)).toEqual(bytes);
    expect(extractPdf).not.toHaveBeenCalled();
    expect(extractFacts).not.toHaveBeenCalled();
    expect(profileRepository.listActive()).toEqual(beforeFacts);

    const repeated = await retainCurrentProfileDocument(dependencies, "renamed.pdf", Uint8Array.from(bytes));
    expect(repeated.id).toBe(retained.id);
    expect(database.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM documents WHERE is_current = 1").get()).toEqual({ count: 1 });
    database.close();
  });

  it("does not create a document when retaining the original fails", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    await expect(retainCurrentProfileDocument({
      database,
      originalDocumentStore: {
        retain: vi.fn(async () => { throw new Error("disk full"); }),
        discardCreated: vi.fn()
      }
    }, "resume.pdf", Buffer.from("%PDF-failure"))).rejects.toThrow("disk full");
    expect(database.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual({ count: 0 });
    database.close();
  });
});
