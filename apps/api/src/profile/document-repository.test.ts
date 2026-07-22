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
    expect(repository.findByFingerprint(retained.fingerprint)).toEqual({ ...retained, importStatus: "retained" });
    expect(repository.claimImport(retained.fingerprint)).toBe(true);
    expect(repository.claimImport(retained.fingerprint)).toBe(false);
    repository.markRetained(retained.fingerprint);
    expect(repository.claimImport(retained.fingerprint)).toBe(true);
    repository.markCompleted(retained.fingerprint);
    expect(repository.findByFingerprint(retained.fingerprint)?.importStatus).toBe("completed");
    database.close();
  });
});
