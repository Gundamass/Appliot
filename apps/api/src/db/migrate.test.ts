import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "./migrate.js";

describe("migrateDatabase", () => {
  it("creates the nullable task name column for a new database", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);

    expect(database.prepare("PRAGMA table_info(application_tasks)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "name" })])
    );
    database.close();
  });

  it("adds the nullable task name column to legacy tasks without losing rows", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE application_tasks (
        id TEXT PRIMARY KEY,
        application_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO application_tasks (id, application_url, created_at, updated_at)
      VALUES ('legacy-task', 'https://jobs.example.test/apply', '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z');
    `);

    migrateDatabase(database);
    migrateDatabase(database);

    expect(database.prepare("PRAGMA table_info(application_tasks)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "name" })])
    );
    expect(database.prepare("SELECT id, name FROM application_tasks WHERE id = 'legacy-task'").get())
      .toEqual({ id: "legacy-task", name: null });
    database.close();
  });

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

  it("upgrades legacy task cleanup triggers to remove all task-scoped data", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    database.exec(`
      DROP TRIGGER application_tasks_cleanup;
      CREATE TRIGGER application_tasks_cleanup
      AFTER DELETE ON application_tasks
      BEGIN
        DELETE FROM application_task_events WHERE task_id = OLD.id;
        DELETE FROM application_task_event_cursors WHERE task_id = OLD.id;
        DELETE FROM application_checkpoints WHERE task_id = OLD.id;
      END;
    `);

    migrateDatabase(database);
    database.prepare(`
      INSERT INTO application_tasks (id, application_url, created_at, updated_at)
      VALUES ('task-1', 'https://jobs.example.test/apply', '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO application_answers (id, task_id, field_path, value_json, evidence_json, confidence, created_at, updated_at)
      VALUES ('answer-1', 'task-1', 'selfEvaluation', '"Task value"', '[{"documentId":"user","page":1,"text":"Task value","extraction":"user"}]', 1, '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO self_evaluation_reviews (task_id, payload_json, status, created_at, updated_at)
      VALUES ('task-1', '{}', 'needs_review', '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')
    `).run();

    database.prepare("DELETE FROM application_tasks WHERE id = 'task-1'").run();

    expect(database.prepare("SELECT COUNT(*) AS count FROM application_answers WHERE task_id = 'task-1'").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM self_evaluation_reviews WHERE task_id = 'task-1'").get())
      .toEqual({ count: 0 });
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
