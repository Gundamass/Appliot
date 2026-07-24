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

  it("upgrades legacy fact revision foreign keys without retaining renamed triggers", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    database.exec(`
      DROP TRIGGER fact_revisions_scope_task_insert;
      DROP TRIGGER fact_revisions_scope_task_update;
      ALTER TABLE fact_revisions RENAME TO fact_revisions_legacy;
      CREATE TABLE fact_revisions (
        id TEXT PRIMARY KEY,
        fact_id TEXT NOT NULL REFERENCES profile_facts(id),
        field_path TEXT NOT NULL,
        value_json TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        scope TEXT NOT NULL,
        task_id TEXT,
        evidence_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      DROP TABLE fact_revisions_legacy;
      CREATE TRIGGER fact_revisions_scope_task_insert
      BEFORE INSERT ON fact_revisions
      BEGIN SELECT 1; END;
      CREATE TRIGGER fact_revisions_scope_task_update
      BEFORE UPDATE OF scope, task_id ON fact_revisions
      BEGIN SELECT 1; END;
    `);

    migrateDatabase(database);

    const foreignKeys = database.prepare("PRAGMA foreign_key_list(fact_revisions)").all() as Array<{ from: string; table: string; on_delete: string }>;
    const triggers = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'fact_revisions_scope_task_%'").all() as Array<{ sql: string }>;
    expect(foreignKeys).toContainEqual(expect.objectContaining({ from: "fact_id", table: "profile_facts", on_delete: "CASCADE" }));
    expect(triggers).toHaveLength(2);
    expect(triggers.map(({ sql }) => sql)).not.toContain(expect.stringContaining("fact_revisions_legacy"));
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
