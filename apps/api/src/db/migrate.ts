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

    CREATE TABLE IF NOT EXISTS self_evaluation_reviews (
      task_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL CHECK (status IN ('needs_review', 'approved', 'blocked', 'promoted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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
