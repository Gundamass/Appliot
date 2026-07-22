import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "./migrate.js";

describe("migrateDatabase", () => {
  it("recovers an import claim interrupted by a previous process", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    database.prepare(`
      INSERT INTO documents (id, fingerprint, filename, source_path, import_status, created_at)
      VALUES (?, ?, ?, ?, 'importing', ?)
    `).run("document-1", "a".repeat(64), "resume.pdf", "C:/local/resume.pdf", "2026-07-22T00:00:00.000Z");

    migrateDatabase(database);

    expect(database.prepare("SELECT import_status FROM documents WHERE id = ?").get("document-1"))
      .toEqual({ import_status: "retained" });
    database.close();
  });
});
