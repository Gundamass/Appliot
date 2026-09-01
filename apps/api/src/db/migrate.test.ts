import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "./migrate.js";

describe("migrateDatabase", () => {
  it("creates conversation persistence tables and indexes idempotently", () => {
    const database = new Database(":memory:");

    migrateDatabase(database);
    migrateDatabase(database);

    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'conversation_%'
      ORDER BY name
    `).all()).toEqual([
      { name: "conversation_confirmations" },
      { name: "conversation_contexts" },
      { name: "conversation_messages" },
      { name: "conversation_process_event_cursors" },
      { name: "conversation_process_events" },
      { name: "conversation_sessions" },
      { name: "conversation_turns" }
    ]);
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'conversation_%'
      ORDER BY name
    `).all()).toEqual(expect.arrayContaining([
      { name: "conversation_messages_session_sequence_unique" },
      { name: "conversation_messages_session_id_idx" },
      { name: "conversation_contexts_session_id_idx" },
      { name: "conversation_confirmations_conversation_status_idx" },
      { name: "conversation_process_events_conversation_id_idx" },
      { name: "conversation_process_events_turn_idx" },
      { name: "conversation_turns_conversation_request_unique" }
    ]));
    expect(database.prepare("PRAGMA foreign_key_list(conversation_messages)").all())
      .toContainEqual(expect.objectContaining({ from: "session_id", table: "conversation_sessions", on_delete: "CASCADE" }));
    expect(database.prepare("PRAGMA foreign_key_list(conversation_contexts)").all())
      .toContainEqual(expect.objectContaining({ from: "session_id", table: "conversation_sessions", on_delete: "CASCADE" }));
    expect(database.prepare("PRAGMA foreign_key_list(conversation_process_events)").all())
      .toContainEqual(expect.objectContaining({ from: "conversation_id", table: "conversation_sessions", on_delete: "CASCADE" }));
    expect(() => database.prepare(`
      INSERT INTO conversation_sessions (id, title, created_at, updated_at)
      VALUES ('session-1', 'Test', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z')
    `).run()).not.toThrow();
    expect(() => database.prepare(`
      INSERT INTO conversation_messages
        (id, session_id, sequence, role, text, cards_json, intent_json, created_at)
      VALUES ('message-1', 'session-1', 1, 'assistant', 'hello', 'not-json', NULL, '2026-08-22T00:00:00.000Z')
    `).run()).toThrow();
    database.close();
  });

  it("upgrades global process events without guessing their message owner", () => {
    const database = new Database(":memory:");
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE conversation_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE conversation_process_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        type TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO conversation_sessions
        VALUES ('c1', '会话', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
      INSERT INTO conversation_process_events
        (conversation_id, type, stage, status, created_at)
        VALUES ('c1', 'process_changed', 'understanding_request', 'running', '2026-09-01T00:00:00.000Z');
    `);

    migrateDatabase(database);

    const columns = database.prepare("PRAGMA table_info(conversation_process_events)").all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "turn_sequence", "step_id", "summary", "details_json"
    ]));
    expect(database.prepare("SELECT COUNT(*) AS count FROM conversation_process_events").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT id FROM conversation_sessions").all()).toEqual([{ id: "c1" }]);
    database.close();
  });

  it("creates job matching persistence tables and indexes idempotently", () => {
    const database = new Database(":memory:");

    migrateDatabase(database);
    migrateDatabase(database);

    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'job_%'
      ORDER BY name
    `).all();
    const indexes = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'job_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const resultForeignKeys = database.prepare("PRAGMA foreign_key_list(job_match_results)").all();
    const postingForeignKeys = database.prepare("PRAGMA foreign_key_list(job_postings)").all();

    expect(tables).toEqual([
      { name: "job_extraction_cursors" },
      { name: "job_match_events" },
      { name: "job_match_expectation_snapshots" },
      { name: "job_match_results" },
      { name: "job_match_sessions" },
      { name: "job_postings" }
    ]);
    expect(indexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "job_match_events_session_sequence_unique",
      "job_match_results_identity_unique",
      "job_postings_session_url_hash_unique"
    ]));
    expect(resultForeignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "session_id", table: "job_match_sessions", on_delete: "CASCADE" }),
      expect.objectContaining({ from: "posting_id", table: "job_postings", on_delete: "CASCADE" })
    ]));
    expect(postingForeignKeys).toContainEqual(
      expect.objectContaining({ from: "session_id", table: "job_match_sessions", on_delete: "CASCADE" })
    );
    database.close();
  });

  it("upgrades legacy job source constraints without losing matching rows", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE application_tasks (
        id TEXT PRIMARY KEY,
        application_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE job_match_sessions (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        state TEXT NOT NULL,
        entry_kind TEXT,
        source TEXT CHECK (source IS NULL OR source IN ('moka', 'dji')),
        initial_url TEXT NOT NULL,
        adapter_version TEXT,
        scoring_version TEXT NOT NULL DEFAULT 'job-match-v1',
        profile_revision INTEGER NOT NULL,
        expectation_revision INTEGER NOT NULL,
        execution_epoch INTEGER NOT NULL DEFAULT 0,
        selected_result_id TEXT,
        selected_posting_content_hash TEXT,
        conflict_summary_hash TEXT,
        selection_idempotency_key TEXT,
        application_task_id TEXT REFERENCES application_tasks(id),
        conversion_idempotency_key TEXT,
        stop_reason TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE job_postings (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES job_match_sessions(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('moka', 'dji')),
        source_job_id TEXT,
        canonical_url TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        extracted_at TEXT NOT NULL
      );
      INSERT INTO job_match_sessions (
        id, state, entry_kind, source, initial_url, profile_revision, expectation_revision,
        created_at, updated_at
      ) VALUES ('legacy-session', 'created', 'job_list', 'moka', 'https://jobs.example.test', 0, 0, '2026-08-24', '2026-08-24');
      INSERT INTO job_postings (
        id, session_id, source, source_job_id, canonical_url, content_hash, payload_json, extracted_at
      ) VALUES ('legacy-posting', 'legacy-session', 'moka', 'legacy-job', 'https://jobs.example.test/1', 'hash-1', '{}', '2026-08-24');
    `);

    migrateDatabase(database);

    expect(database.prepare("SELECT source FROM job_match_sessions WHERE id = 'legacy-session'").get())
      .toEqual({ source: "moka" });
    expect(database.prepare("SELECT source FROM job_postings WHERE id = 'legacy-posting'").get())
      .toEqual({ source: "moka" });
    expect(() => database.prepare(`
      INSERT INTO job_match_sessions (
        id, state, entry_kind, source, initial_url, profile_revision, expectation_revision,
        created_at, updated_at
      ) VALUES ('baidu-session', 'created', 'job_list', 'baidu', 'https://talent.baidu.com/jobs/list', 0, 0, '2026-08-24', '2026-08-24')
    `).run()).not.toThrow();
    expect(() => database.prepare(`
      INSERT INTO job_postings (
        id, session_id, source, canonical_url, content_hash, payload_json, extracted_at
      ) VALUES ('baidu-posting', 'baidu-session', 'baidu', 'https://talent.baidu.com/jobs/detail/GRADUATE/1', 'hash-2', '{}', '2026-08-24')
    `).run()).not.toThrow();
    database.close();
  });

  it("upgrades checkpoint state constraints for persistent challenge pauses without losing rows", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    database.prepare(`
      INSERT INTO application_checkpoints (
        task_id, sequence, state, url, stage, snapshot_id, field_ids_json,
        questions_json, snapshot_json, content_review_json, field_coverage_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "task-legacy", 1, "observing", "https://jobs.example.test/apply", "application_form",
      "snapshot-legacy", "[]", "[]", null, null, null, "2026-08-15T00:00:00.000Z"
    );
    database.prepare(`
      INSERT INTO application_task_events (task_id, type, state, created_at)
      VALUES (?, 'state_changed', ?, ?)
    `).run("task-legacy", "observing_page", "2026-08-15T00:00:00.000Z");

    migrateDatabase(database);
    database.prepare(`
      INSERT INTO application_checkpoints (
        task_id, sequence, state, url, stage, snapshot_id, field_ids_json,
        questions_json, snapshot_json, content_review_json, field_coverage_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "task-challenge", 1, "awaiting_challenge", "https://jobs.example.test/apply", "application_form",
      "snapshot-challenge", "[]", "[]", null, null, null, "2026-08-15T00:01:00.000Z"
    );
    database.prepare(`
      INSERT INTO application_task_events (task_id, type, state, created_at)
      VALUES (?, 'state_changed', ?, ?)
    `).run("task-challenge", "awaiting_challenge", "2026-08-15T00:01:00.000Z");

    expect(database.prepare("SELECT task_id, state FROM application_checkpoints ORDER BY task_id").all())
      .toEqual([
        { task_id: "task-challenge", state: "awaiting_challenge" },
        { task_id: "task-legacy", state: "observing" }
      ]);
    expect(database.prepare("SELECT task_id, state FROM application_task_events ORDER BY task_id").all())
      .toEqual([
        { task_id: "task-challenge", state: "awaiting_challenge" },
        { task_id: "task-legacy", state: "observing_page" }
      ]);
    database.close();
  });

  it("creates profile revision metadata and task synchronization columns idempotently", () => {
    const database = new Database(":memory:");

    migrateDatabase(database);
    migrateDatabase(database);

    expect(database.prepare("SELECT revision FROM profile_metadata WHERE id = 1").get())
      .toEqual({ revision: 0 });
    expect(database.prepare("PRAGMA table_info(application_tasks)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "profile_revision_applied" }),
      expect.objectContaining({ name: "profile_sync_status" }),
      expect.objectContaining({ name: "profile_sync_error" })
    ]));
    database.close();
  });

  it("adds profile synchronization metadata to legacy tasks without losing rows", () => {
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

    expect(database.prepare(`
      SELECT id, profile_revision_applied, profile_sync_status, profile_sync_error
      FROM application_tasks WHERE id = 'legacy-task'
    `).get()).toEqual({
      id: "legacy-task",
      profile_revision_applied: 0,
      profile_sync_status: "current",
      profile_sync_error: null
    });
    database.close();
  });

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

  it("creates agent trace persistence idempotently", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    migrateDatabase(database);

    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_trace_events'").get())
      .toEqual({ name: "agent_trace_events" });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'agent_trace_events_run_sequence_idx'").get())
      .toEqual({ name: "agent_trace_events_run_sequence_idx" });
    database.close();
  });

  it("creates the LangSmith outbox schema idempotently", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    migrateDatabase(database);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'langsmith_trace_outbox'").get())
      .toEqual({ name: "langsmith_trace_outbox" });
    database.close();
  });

  it("creates isolated LangGraph checkpoint and pending-write tables idempotently", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    migrateDatabase(database);

    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('agent_checkpoints', 'agent_checkpoint_writes')
      ORDER BY name
    `).all()).toEqual([
      { name: "agent_checkpoint_writes" },
      { name: "agent_checkpoints" }
    ]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'agent_checkpoints_thread_namespace_id_idx'").get())
      .toEqual({ name: "agent_checkpoints_thread_namespace_id_idx" });
    expect(database.prepare("PRAGMA foreign_key_list(agent_checkpoint_writes)").all())
      .toContainEqual(expect.objectContaining({
        from: "thread_id", table: "agent_checkpoints", on_delete: "CASCADE"
      }));
    database.close();
  });

  it("upgrades an earlier checkpoint table with the metadata serializer type", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE agent_checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT NOT NULL,
        checkpoint_blob BLOB NOT NULL,
        metadata_blob BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
    `);

    migrateDatabase(database);
    migrateDatabase(database);

    expect(database.prepare("PRAGMA table_info(agent_checkpoints)").all())
      .toContainEqual(expect.objectContaining({ name: "metadata_type" }));
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

  it("retains graph review cleanup while rebuilding challenge-state tables", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    database.exec(`
      DROP TRIGGER application_tasks_cleanup;
      ALTER TABLE application_task_events RENAME TO application_task_events_legacy;
      CREATE TABLE application_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type = 'state_changed'),
        state TEXT NOT NULL CHECK (state IN (
          'created', 'observing_page', 'waiting_for_login', 'needs_questions',
          'awaiting_content_review', 'filling', 'validating', 'navigating',
          'review_locked', 'cancelled', 'failed'
        )),
        created_at TEXT NOT NULL
      );
      DROP TABLE application_task_events_legacy;
    `);

    migrateDatabase(database);

    const trigger = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'application_tasks_cleanup'")
      .get() as { sql: string };
    expect(trigger.sql).toContain("DELETE FROM agent_application_reviews WHERE task_id = OLD.id;");
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
