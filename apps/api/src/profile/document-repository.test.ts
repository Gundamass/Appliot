import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createDocumentRepository } from "./document-repository.js";

describe("DocumentRepository", () => {
  it("keeps retained source metadata while coordinating retryable import state", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createDocumentRepository(database);
    const retained = {
      id: "document-1",
      fingerprint: "a".repeat(64),
      filename: "resume.pdf",
      sourcePath: "C:/local/resume.pdf",
      createdAt: "2026-07-22T00:00:00.000Z"
    };

    repository.createRetained(retained);
    expect(repository.findByFingerprint(retained.fingerprint)).toEqual({
      ...retained,
      importStatus: "retained",
      isCurrent: false
    });
    repository.setCurrent(retained.id);
    expect(repository.findCurrent()?.id).toBe(retained.id);
    expect(repository.claimImport(retained.id)).toBe(true);
    expect(repository.claimImport(retained.id)).toBe(false);
    repository.releaseImport(retained.id);
    expect(repository.claimImport(retained.id)).toBe(true);
    expect(repository.completeCurrentImport(retained.id)).toBe(true);
    expect(repository.findByFingerprint(retained.fingerprint)?.importStatus).toBe("completed");
    database.close();
  });

  it("switches the unique current document and retries failed parsing", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createDocumentRepository(database);
    const first = repository.createRetained({
      id: "document-1",
      fingerprint: "a".repeat(64),
      filename: "first.pdf",
      sourcePath: "C:/local/first.pdf",
      createdAt: "2026-07-22T00:00:00.000Z"
    });
    const second = repository.createRetained({
      id: "document-2",
      fingerprint: "b".repeat(64),
      filename: "second.pdf",
      sourcePath: "C:/local/second.pdf",
      createdAt: "2026-07-23T00:00:00.000Z"
    });

    repository.setCurrent(first.id);
    repository.setCurrent(first.id);
    expect(repository.findCurrent()?.id).toBe(first.id);
    repository.setCurrent(second.id);
    expect(repository.findById(first.id)?.isCurrent).toBe(false);
    expect(repository.findCurrent()?.id).toBe(second.id);
    expect(database.prepare("SELECT COUNT(*) AS count FROM documents WHERE is_current = 1").get())
      .toEqual({ count: 1 });

    expect(repository.claimImport(second.id)).toBe(true);
    repository.markFailed(second.id);
    expect(repository.findCurrent()?.importStatus).toBe("failed");
    expect(repository.claimImport(second.id)).toBe(true);
    repository.setCurrent(first.id);
    expect(repository.completeCurrentImport(second.id)).toBe(false);
    repository.releaseImport(second.id);
    expect(repository.findById(second.id)?.importStatus).toBe("retained");
    database.close();
  });
});
