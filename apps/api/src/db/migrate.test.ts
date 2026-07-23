import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "./migrate.js";

describe("migrateDatabase", () => {
  it("creates versioned embedding persistence tables idempotently", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    migrateDatabase(database);

    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('embedding_indexes', 'fact_embeddings') ORDER BY name").all())
      .toEqual([{ name: "embedding_indexes" }, { name: "fact_embeddings" }]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'").get())
      .toEqual({ name: "embeddings" });
    database.close();
  });

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
