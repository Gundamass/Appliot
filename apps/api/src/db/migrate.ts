import type { SqliteDatabase } from "./client.js";

export function migrateDatabase(database: SqliteDatabase): void {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
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
      CHECK (scope != 'application' OR task_id IS NOT NULL),
      CHECK (json_valid(value_json)),
      CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array' AND json_array_length(evidence_json) > 0)
    );
    CREATE INDEX IF NOT EXISTS profile_facts_field_path_idx ON profile_facts(field_path);

    CREATE TABLE IF NOT EXISTS fact_revisions (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL REFERENCES profile_facts(id),
      field_path TEXT NOT NULL,
      value_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('extracted', 'user_confirmed', 'user_corrected', 'superseded')),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      scope TEXT NOT NULL CHECK (scope IN ('profile', 'application')),
      task_id TEXT,
      evidence_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      CHECK (scope != 'application' OR task_id IS NOT NULL),
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

    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      document_chunk_id TEXT NOT NULL REFERENCES document_chunks(id),
      model TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS embeddings_document_chunk_id_idx ON embeddings(document_chunk_id);
  `);
}
