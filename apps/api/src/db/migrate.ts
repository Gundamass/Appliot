import type { SqliteDatabase } from "./client.js";

export function migrateDatabase(database: SqliteDatabase): void {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      source_path TEXT NOT NULL,
      import_status TEXT NOT NULL CHECK (import_status IN ('retained', 'importing', 'completed')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      page INTEGER NOT NULL CHECK (page > 0),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS document_chunks_document_id_idx ON document_chunks(document_id);

    CREATE TABLE IF NOT EXISTS profile_facts (
      id TEXT PRIMARY KEY,
      field_path TEXT NOT NULL,
      value_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('extracted', 'user_confirmed', 'user_corrected', 'superseded')),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      scope TEXT NOT NULL CHECK (scope IN ('profile', 'application')),
      task_id TEXT,
      evidence_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((scope = 'profile' AND task_id IS NULL) OR (scope = 'application' AND task_id IS NOT NULL)),
      CHECK (json_valid(value_json)),
      CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array' AND json_array_length(evidence_json) > 0)
    );
    CREATE INDEX IF NOT EXISTS profile_facts_field_path_idx ON profile_facts(field_path);

    CREATE TABLE IF NOT EXISTS fact_revisions (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL REFERENCES profile_facts(id) ON DELETE CASCADE,
      field_path TEXT NOT NULL,
      value_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('extracted', 'user_confirmed', 'user_corrected', 'superseded')),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      scope TEXT NOT NULL CHECK (scope IN ('profile', 'application')),
      task_id TEXT,
      evidence_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      CHECK ((scope = 'profile' AND task_id IS NULL) OR (scope = 'application' AND task_id IS NOT NULL)),
      CHECK (json_valid(value_json)),
      CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array' AND json_array_length(evidence_json) > 0),
      UNIQUE (fact_id, revision)
    );
    CREATE INDEX IF NOT EXISTS fact_revisions_fact_id_revision_idx ON fact_revisions(fact_id, revision);

    CREATE TABLE IF NOT EXISTS application_answers (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      field_path TEXT NOT NULL,
      value_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (task_id, field_path),
      CHECK (json_valid(value_json)),
      CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array' AND json_array_length(evidence_json) > 0)
    );
    CREATE INDEX IF NOT EXISTS application_answers_task_field_idx ON application_answers(task_id, field_path);

    CREATE TABLE IF NOT EXISTS application_tasks (
      id TEXT PRIMARY KEY,
      name TEXT,
      application_url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      profile_revision_applied INTEGER NOT NULL DEFAULT 0 CHECK (profile_revision_applied >= 0),
      profile_sync_status TEXT NOT NULL DEFAULT 'current' CHECK (profile_sync_status IN ('current', 'pending', 'failed')),
      profile_sync_error TEXT
    );

    CREATE TABLE IF NOT EXISTS profile_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    );
    INSERT OR IGNORE INTO profile_metadata (id, revision) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS application_task_events (
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
    CREATE INDEX IF NOT EXISTS application_task_events_task_id_id_idx
      ON application_task_events(task_id, id);

    CREATE TABLE IF NOT EXISTS application_task_event_cursors (
      task_id TEXT PRIMARY KEY,
      discarded_through_id INTEGER NOT NULL CHECK (discarded_through_id > 0)
    );

    CREATE TABLE IF NOT EXISTS self_evaluation_reviews (
      task_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL CHECK (status IN ('needs_review', 'approved', 'blocked', 'promoted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS application_checkpoints (
      task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      state TEXT NOT NULL CHECK (state IN (
        'created', 'observing', 'awaiting_login', 'needs_questions',
        'awaiting_content_review', 'filling', 'validating', 'navigating',
        'review_locked', 'cancelled', 'failed'
      )),
      url TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('login', 'application_form', 'review', 'success', 'unknown')),
      snapshot_id TEXT NOT NULL,
      field_ids_json TEXT NOT NULL CHECK (json_valid(field_ids_json) AND json_type(field_ids_json) = 'array'),
      questions_json TEXT NOT NULL CHECK (json_valid(questions_json) AND json_type(questions_json) = 'array'),
      snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
      content_review_json TEXT CHECK (content_review_json IS NULL OR json_valid(content_review_json)),
      field_coverage_json TEXT CHECK (field_coverage_json IS NULL OR json_valid(field_coverage_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, sequence)
    );

    DROP TRIGGER IF EXISTS application_tasks_cleanup;
    CREATE TRIGGER application_tasks_cleanup
    AFTER DELETE ON application_tasks
    BEGIN
      DELETE FROM application_task_events WHERE task_id = OLD.id;
      DELETE FROM application_task_event_cursors WHERE task_id = OLD.id;
      DELETE FROM application_checkpoints WHERE task_id = OLD.id;
      DELETE FROM application_answers WHERE task_id = OLD.id;
      DELETE FROM self_evaluation_reviews WHERE task_id = OLD.id;
      DELETE FROM profile_facts WHERE scope = 'application' AND task_id = OLD.id;
    END;

    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      document_chunk_id TEXT NOT NULL REFERENCES document_chunks(id),
      model TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS embeddings_document_chunk_id_idx ON embeddings(document_chunk_id);

    CREATE TABLE IF NOT EXISTS embedding_indexes (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      model_revision TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0),
      normalization TEXT NOT NULL CHECK (normalization = 'l2'),
      instruction_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('building', 'active', 'retired')),
      created_at TEXT NOT NULL,
      activated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS embedding_indexes_one_active
      ON embedding_indexes(status) WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS fact_embeddings (
      index_id TEXT NOT NULL REFERENCES embedding_indexes(id),
      fact_id TEXT NOT NULL REFERENCES profile_facts(id) ON DELETE CASCADE,
      fact_revision INTEGER NOT NULL CHECK (fact_revision > 0),
      content_hash TEXT NOT NULL,
      vector_json TEXT NOT NULL CHECK (json_valid(vector_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (index_id, fact_id)
    );
  `);

  const taskColumns = database.prepare("PRAGMA table_info(application_tasks)").all() as Array<{ name: string }>;
  if (!taskColumns.some((column) => column.name === "name")) {
    database.exec("ALTER TABLE application_tasks ADD COLUMN name TEXT");
  }
  if (!taskColumns.some((column) => column.name === "profile_revision_applied")) {
    database.exec("ALTER TABLE application_tasks ADD COLUMN profile_revision_applied INTEGER NOT NULL DEFAULT 0 CHECK (profile_revision_applied >= 0)");
  }
  if (!taskColumns.some((column) => column.name === "profile_sync_status")) {
    database.exec("ALTER TABLE application_tasks ADD COLUMN profile_sync_status TEXT NOT NULL DEFAULT 'current' CHECK (profile_sync_status IN ('current', 'pending', 'failed'))");
  }
  if (!taskColumns.some((column) => column.name === "profile_sync_error")) {
    database.exec("ALTER TABLE application_tasks ADD COLUMN profile_sync_error TEXT");
  }

  const checkpointColumns = database.prepare("PRAGMA table_info(application_checkpoints)").all() as Array<{ name: string }>;
  if (!checkpointColumns.some((column) => column.name === "snapshot_json")) {
    database.exec("ALTER TABLE application_checkpoints ADD COLUMN snapshot_json TEXT");
  }
  if (!checkpointColumns.some((column) => column.name === "content_review_json")) {
    database.exec("ALTER TABLE application_checkpoints ADD COLUMN content_review_json TEXT");
  }
  if (!checkpointColumns.some((column) => column.name === "field_coverage_json")) {
    database.exec("ALTER TABLE application_checkpoints ADD COLUMN field_coverage_json TEXT");
  }

  upgradeFactForeignKeys(database);

  const documentColumns = database.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
  if (!documentColumns.some((column) => column.name === "source_path")) {
    database.exec("ALTER TABLE documents ADD COLUMN source_path TEXT NOT NULL DEFAULT ''");
  }
  if (!documentColumns.some((column) => column.name === "import_status")) {
    database.exec("ALTER TABLE documents ADD COLUMN import_status TEXT NOT NULL DEFAULT 'completed' CHECK (import_status IN ('retained', 'importing', 'completed'))");
  }
  database.prepare("UPDATE documents SET import_status = 'retained' WHERE import_status = 'importing'").run();

  database.exec(`
    CREATE TRIGGER IF NOT EXISTS profile_facts_scope_task_insert
    BEFORE INSERT ON profile_facts
    WHEN NOT ((NEW.scope = 'profile' AND NEW.task_id IS NULL) OR (NEW.scope = 'application' AND NEW.task_id IS NOT NULL))
    BEGIN SELECT RAISE(ABORT, 'profile fact scope and task mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS profile_facts_scope_task_update
    BEFORE UPDATE OF scope, task_id ON profile_facts
    WHEN NOT ((NEW.scope = 'profile' AND NEW.task_id IS NULL) OR (NEW.scope = 'application' AND NEW.task_id IS NOT NULL))
    BEGIN SELECT RAISE(ABORT, 'profile fact scope and task mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS fact_revisions_scope_task_insert
    BEFORE INSERT ON fact_revisions
    WHEN NOT ((NEW.scope = 'profile' AND NEW.task_id IS NULL) OR (NEW.scope = 'application' AND NEW.task_id IS NOT NULL))
    BEGIN SELECT RAISE(ABORT, 'fact revision scope and task mismatch'); END;
    CREATE TRIGGER IF NOT EXISTS fact_revisions_scope_task_update
    BEFORE UPDATE OF scope, task_id ON fact_revisions
    WHEN NOT ((NEW.scope = 'profile' AND NEW.task_id IS NULL) OR (NEW.scope = 'application' AND NEW.task_id IS NOT NULL))
    BEGIN SELECT RAISE(ABORT, 'fact revision scope and task mismatch'); END;
  `);
}

function upgradeFactForeignKeys(database: SqliteDatabase): void {
  const factRevisionForeignKeys = database.prepare("PRAGMA foreign_key_list(fact_revisions)").all() as ForeignKeyRow[];
  if (!hasCascadeDelete(factRevisionForeignKeys, "fact_id", "profile_facts")) {
    database.exec(`
      BEGIN;
      ALTER TABLE fact_revisions RENAME TO fact_revisions_legacy;
      CREATE TABLE fact_revisions (
        id TEXT PRIMARY KEY,
        fact_id TEXT NOT NULL REFERENCES profile_facts(id) ON DELETE CASCADE,
        field_path TEXT NOT NULL,
        value_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('extracted', 'user_confirmed', 'user_corrected', 'superseded')),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        scope TEXT NOT NULL CHECK (scope IN ('profile', 'application')),
        task_id TEXT,
        evidence_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        CHECK ((scope = 'profile' AND task_id IS NULL) OR (scope = 'application' AND task_id IS NOT NULL)),
        CHECK (json_valid(value_json)),
        CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array' AND json_array_length(evidence_json) > 0),
        UNIQUE (fact_id, revision)
      );
      INSERT INTO fact_revisions SELECT * FROM fact_revisions_legacy;
      DROP TABLE fact_revisions_legacy;
      CREATE INDEX fact_revisions_fact_id_revision_idx ON fact_revisions(fact_id, revision);
      COMMIT;
    `);
  }

  const factEmbeddingForeignKeys = database.prepare("PRAGMA foreign_key_list(fact_embeddings)").all() as ForeignKeyRow[];
  if (!hasCascadeDelete(factEmbeddingForeignKeys, "fact_id", "profile_facts")) {
    database.exec(`
      BEGIN;
      ALTER TABLE fact_embeddings RENAME TO fact_embeddings_legacy;
      CREATE TABLE fact_embeddings (
        index_id TEXT NOT NULL REFERENCES embedding_indexes(id),
        fact_id TEXT NOT NULL REFERENCES profile_facts(id) ON DELETE CASCADE,
        fact_revision INTEGER NOT NULL CHECK (fact_revision > 0),
        content_hash TEXT NOT NULL,
        vector_json TEXT NOT NULL CHECK (json_valid(vector_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (index_id, fact_id)
      );
      INSERT INTO fact_embeddings SELECT * FROM fact_embeddings_legacy;
      DROP TABLE fact_embeddings_legacy;
      COMMIT;
    `);
  }
}

interface ForeignKeyRow {
  table: string;
  from: string;
  on_delete: string;
}

function hasCascadeDelete(foreignKeys: ForeignKeyRow[], column: string, table: string): boolean {
  return foreignKeys.some((foreignKey) =>
    foreignKey.from === column && foreignKey.table === table && foreignKey.on_delete === "CASCADE"
  );
}
