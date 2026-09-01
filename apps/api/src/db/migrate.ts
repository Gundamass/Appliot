import type { SqliteDatabase } from "./client.js";

export function migrateDatabase(database: SqliteDatabase): void {
  upgradeConversationProcessEvents(database);
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
      profile_sync_error TEXT,
      orchestrator TEXT NOT NULL DEFAULT 'xstate-v1' CHECK (orchestrator IN ('xstate-v1', 'langgraph-v1'))
    );

    CREATE TABLE IF NOT EXISTS agent_application_reviews (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES application_tasks(id) ON DELETE CASCADE,
      interrupt_id TEXT NOT NULL,
      field_id TEXT NOT NULL,
      field_label TEXT NOT NULL,
      original TEXT NOT NULL,
      draft TEXT NOT NULL,
      reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json) AND json_type(reasons_json) = 'array'),
      evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
      unsupported_claims_json TEXT NOT NULL CHECK (json_valid(unsupported_claims_json) AND json_type(unsupported_claims_json) = 'array'),
      status TEXT NOT NULL CHECK (status IN ('needs_review', 'approved', 'blocked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (task_id, interrupt_id)
    );
    CREATE INDEX IF NOT EXISTS agent_application_reviews_task_status_idx
      ON agent_application_reviews(task_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS profile_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    );
    INSERT OR IGNORE INTO profile_metadata (id, revision) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS job_match_sessions (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      state TEXT NOT NULL CHECK (state IN (
        'created', 'awaiting_filter_confirmation', 'opening_job_page', 'awaiting_login',
        'applying_filters', 'extracting_jobs', 'matching_jobs', 'awaiting_job_selection',
        'selected', 'converted_to_application', 'awaiting_challenge', 'paused', 'failed',
        'cancelled', 'expired'
      )),
      entry_kind TEXT CHECK (entry_kind IS NULL OR entry_kind IN ('job_list', 'job_detail', 'application_form')),
      source TEXT CHECK (source IS NULL OR source IN ('moka', 'dji', 'baidu')),
      initial_url TEXT NOT NULL,
      adapter_version TEXT,
      scoring_version TEXT NOT NULL DEFAULT 'job-match-v1' CHECK (scoring_version = 'job-match-v1'),
      profile_revision INTEGER NOT NULL CHECK (profile_revision >= 0),
      expectation_revision INTEGER NOT NULL CHECK (expectation_revision >= 0),
      execution_epoch INTEGER NOT NULL DEFAULT 0 CHECK (execution_epoch >= 0),
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
    CREATE UNIQUE INDEX IF NOT EXISTS job_match_sessions_selection_idempotency_unique
      ON job_match_sessions(selection_idempotency_key) WHERE selection_idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS job_match_sessions_conversion_idempotency_unique
      ON job_match_sessions(conversion_idempotency_key) WHERE conversion_idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS job_match_expectation_snapshots (
      session_id TEXT NOT NULL REFERENCES job_match_sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      confirmed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, revision)
    );

    CREATE TABLE IF NOT EXISTS job_postings (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES job_match_sessions(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('moka', 'dji', 'baidu')),
      source_job_id TEXT,
      canonical_url TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      extracted_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS job_postings_session_url_hash_unique
      ON job_postings(session_id, source, canonical_url, content_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS job_postings_session_source_id_hash_unique
      ON job_postings(session_id, source, source_job_id, content_hash) WHERE source_job_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS job_postings_session_id_idx ON job_postings(session_id, id);

    CREATE TABLE IF NOT EXISTS job_match_results (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES job_match_sessions(id) ON DELETE CASCADE,
      posting_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version >= 0),
      scoring_version TEXT NOT NULL CHECK (scoring_version = 'job-match-v1'),
      profile_revision INTEGER NOT NULL CHECK (profile_revision >= 0),
      expectation_revision INTEGER NOT NULL CHECK (expectation_revision >= 0),
      posting_content_hash TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS job_match_results_identity_unique
      ON job_match_results(
        session_id, posting_id, scoring_version, profile_revision,
        expectation_revision, posting_content_hash
      );
    CREATE INDEX IF NOT EXISTS job_match_results_session_ranking_idx
      ON job_match_results(session_id, stale, id);

    CREATE TABLE IF NOT EXISTS job_extraction_cursors (
      session_id TEXT PRIMARY KEY REFERENCES job_match_sessions(id) ON DELETE CASCADE,
      cursor_json TEXT NOT NULL CHECK (json_valid(cursor_json)),
      pages_read INTEGER NOT NULL DEFAULT 0 CHECK (pages_read >= 0),
      elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_ms >= 0),
      new_jobs INTEGER NOT NULL DEFAULT 0 CHECK (new_jobs >= 0),
      consecutive_no_new_pages INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_no_new_pages >= 0),
      continuation_token TEXT,
      stop_reason TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_match_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES job_match_sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      type TEXT NOT NULL,
      idempotency_key TEXT,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS job_match_events_session_sequence_unique
      ON job_match_events(session_id, sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS job_match_events_session_idempotency_unique
      ON job_match_events(session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS application_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type = 'state_changed'),
      state TEXT NOT NULL CHECK (state IN (
        'created', 'observing_page', 'waiting_for_login', 'needs_questions',
        'awaiting_content_review', 'awaiting_challenge', 'filling', 'validating', 'navigating',
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
        'awaiting_content_review', 'awaiting_challenge', 'filling', 'validating', 'navigating',
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
      DELETE FROM agent_application_reviews WHERE task_id = OLD.id;
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

    CREATE TABLE IF NOT EXISTS agent_trace_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      node TEXT NOT NULL,
      kind TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL,
      UNIQUE (run_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS agent_trace_events_run_sequence_idx
      ON agent_trace_events(run_id, sequence);

    CREATE TABLE IF NOT EXISTS langsmith_trace_outbox (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL UNIQUE,
      run_id_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'sent', 'dead_letter')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TEXT NOT NULL,
      remote_run_id TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS langsmith_trace_outbox_ready_idx
      ON langsmith_trace_outbox(status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS agent_checkpoints (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      type TEXT NOT NULL,
      metadata_type TEXT NOT NULL DEFAULT 'json',
      checkpoint_blob BLOB NOT NULL,
      metadata_blob BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
    );
    CREATE INDEX IF NOT EXISTS agent_checkpoints_thread_namespace_id_idx
      ON agent_checkpoints(thread_id, checkpoint_ns, checkpoint_id);

    CREATE TABLE IF NOT EXISTS agent_checkpoint_writes (
      thread_id TEXT NOT NULL,
      checkpoint_ns TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      write_index INTEGER NOT NULL,
      channel TEXT NOT NULL,
      type TEXT NOT NULL,
      value_blob BLOB NOT NULL,
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, write_index),
      FOREIGN KEY (thread_id, checkpoint_ns, checkpoint_id)
        REFERENCES agent_checkpoints(thread_id, checkpoint_ns, checkpoint_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS conversation_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      text TEXT NOT NULL,
      cards_json TEXT NOT NULL CHECK (json_valid(cards_json) AND json_type(cards_json) = 'array'),
      intent_json TEXT CHECK (intent_json IS NULL OR json_valid(intent_json)),
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_session_sequence_unique
      ON conversation_messages(session_id, sequence);
    CREATE INDEX IF NOT EXISTS conversation_messages_session_id_idx
      ON conversation_messages(session_id, sequence);

    CREATE TABLE IF NOT EXISTS conversation_contexts (
      session_id TEXT PRIMARY KEY REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version >= 0),
      context_json TEXT NOT NULL CHECK (json_valid(context_json) AND json_type(context_json) = 'object'),
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversation_contexts_session_id_idx
      ON conversation_contexts(session_id);

    CREATE TABLE IF NOT EXISTS conversation_turns (
      conversation_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      input_text TEXT NOT NULL,
      response_json TEXT NOT NULL CHECK (json_valid(response_json) AND json_type(response_json) = 'object'),
      created_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, request_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_conversation_request_unique
      ON conversation_turns(conversation_id, request_id);

    CREATE TABLE IF NOT EXISTS conversation_confirmations (
      confirmation_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
      status TEXT NOT NULL CHECK (status IN ('pending', 'consumed')),
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS conversation_confirmations_conversation_status_idx
      ON conversation_confirmations(conversation_id, status, created_at);

    CREATE TABLE IF NOT EXISTS conversation_process_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      turn_sequence INTEGER NOT NULL CHECK (turn_sequence > 0),
      step_id TEXT NOT NULL CHECK (length(step_id) BETWEEN 1 AND 96),
      type TEXT NOT NULL CHECK (type = 'process_changed'),
      stage TEXT NOT NULL CHECK (stage IN (
        'understanding_request', 'searching_recruitment_site', 'validating_recruitment_site',
        'recruitment_site_found', 'waiting_for_confirmation', 'processing_confirmation',
        'reading_recruitment_site', 'loading_recommendations', 'matching_jobs',
        'loading_application_progress', 'creating_job_match_session', 'job_match_session_ready',
        'creating_application_task', 'generating_response', 'completed', 'failed'
      )),
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'waiting', 'failed')),
      summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
      details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversation_process_events_conversation_id_idx
      ON conversation_process_events(conversation_id, id);
    CREATE INDEX IF NOT EXISTS conversation_process_events_turn_idx
      ON conversation_process_events(conversation_id, turn_sequence, id);

    CREATE TABLE IF NOT EXISTS conversation_process_event_cursors (
      conversation_id TEXT PRIMARY KEY REFERENCES conversation_sessions(id) ON DELETE CASCADE,
      discarded_through_id INTEGER NOT NULL CHECK (discarded_through_id > 0)
    );
  `);

  const agentCheckpointColumns = database.prepare("PRAGMA table_info(agent_checkpoints)").all() as Array<{ name: string }>;
  if (!agentCheckpointColumns.some((column) => column.name === "metadata_type")) {
    database.exec("ALTER TABLE agent_checkpoints ADD COLUMN metadata_type TEXT NOT NULL DEFAULT 'json'");
  }

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
  if (!taskColumns.some((column) => column.name === "orchestrator")) {
    database.exec("ALTER TABLE application_tasks ADD COLUMN orchestrator TEXT NOT NULL DEFAULT 'xstate-v1' CHECK (orchestrator IN ('xstate-v1', 'langgraph-v1'))");
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

  upgradeChallengeStateConstraints(database);

  upgradeFactForeignKeys(database);

  upgradeJobSourceConstraints(database);

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

function upgradeChallengeStateConstraints(database: SqliteDatabase): void {
  const eventTableNeedsUpgrade = !tableSql(database, "application_task_events").includes("'awaiting_challenge'");
  const checkpointTableNeedsUpgrade = !tableSql(database, "application_checkpoints").includes("'awaiting_challenge'");
  if (!eventTableNeedsUpgrade && !checkpointTableNeedsUpgrade) return;

  const upgrade = database.transaction(() => {
    database.exec("DROP TRIGGER IF EXISTS application_tasks_cleanup");

    if (eventTableNeedsUpgrade) {
      database.exec(`
        DROP INDEX IF EXISTS application_task_events_task_id_id_idx;
        ALTER TABLE application_task_events RENAME TO application_task_events_challenge_legacy;
        CREATE TABLE application_task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type = 'state_changed'),
          state TEXT NOT NULL CHECK (state IN (
            'created', 'observing_page', 'waiting_for_login', 'needs_questions',
            'awaiting_content_review', 'awaiting_challenge', 'filling', 'validating', 'navigating',
            'review_locked', 'cancelled', 'failed'
          )),
          created_at TEXT NOT NULL
        );
        INSERT INTO application_task_events (id, task_id, type, state, created_at)
        SELECT id, task_id, type, state, created_at
        FROM application_task_events_challenge_legacy;
        DROP TABLE application_task_events_challenge_legacy;
      `);
    }

    if (checkpointTableNeedsUpgrade) {
      database.exec(`
        ALTER TABLE application_checkpoints RENAME TO application_checkpoints_challenge_legacy;
        CREATE TABLE application_checkpoints (
          task_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          state TEXT NOT NULL CHECK (state IN (
            'created', 'observing', 'awaiting_login', 'needs_questions',
            'awaiting_content_review', 'awaiting_challenge', 'filling', 'validating', 'navigating',
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
        INSERT INTO application_checkpoints (
          task_id, sequence, state, url, stage, snapshot_id, field_ids_json,
          questions_json, snapshot_json, content_review_json, field_coverage_json, created_at
        )
        SELECT
          task_id, sequence, state, url, stage, snapshot_id, field_ids_json,
          questions_json, snapshot_json, content_review_json, field_coverage_json, created_at
        FROM application_checkpoints_challenge_legacy;
        DROP TABLE application_checkpoints_challenge_legacy;
      `);
    }

    database.exec(`
      CREATE INDEX IF NOT EXISTS application_task_events_task_id_id_idx
        ON application_task_events(task_id, id);
      CREATE TRIGGER application_tasks_cleanup
      AFTER DELETE ON application_tasks
      BEGIN
        DELETE FROM application_task_events WHERE task_id = OLD.id;
        DELETE FROM application_task_event_cursors WHERE task_id = OLD.id;
        DELETE FROM application_checkpoints WHERE task_id = OLD.id;
        DELETE FROM application_answers WHERE task_id = OLD.id;
        DELETE FROM self_evaluation_reviews WHERE task_id = OLD.id;
        DELETE FROM agent_application_reviews WHERE task_id = OLD.id;
        DELETE FROM profile_facts WHERE scope = 'application' AND task_id = OLD.id;
      END;
    `);
  });

  upgrade();
}

function tableSql(database: SqliteDatabase, table: string): string {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql?: string } | undefined;
  return row?.sql ?? "";
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

function upgradeConversationProcessEvents(database: SqliteDatabase): void {
  const existing = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_process_events'"
  ).get();
  if (existing === undefined) return;

  const columns = database.prepare("PRAGMA table_info(conversation_process_events)").all() as Array<{ name: string }>;
  if (columns.some(({ name }) => name === "turn_sequence")) return;

  database.exec(`
    DROP TABLE IF EXISTS conversation_process_event_cursors;
    DROP TABLE conversation_process_events;
  `);
}

function upgradeJobSourceConstraints(database: SqliteDatabase): void {
  const sessionNeedsUpgrade = !tableSql(database, "job_match_sessions").includes("'baidu'");
  const postingNeedsUpgrade = !tableSql(database, "job_postings").includes("'baidu'");
  if (!sessionNeedsUpgrade && !postingNeedsUpgrade) return;

  const foreignKeysWereEnabled = database.pragma("foreign_keys", { simple: true }) === 1;
  if (foreignKeysWereEnabled) database.pragma("foreign_keys = OFF");
  try {
    const upgrade = database.transaction(() => {
      if (sessionNeedsUpgrade) {
        database.exec(`
          CREATE TABLE job_match_sessions_source_new (
            id TEXT PRIMARY KEY,
            version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
            state TEXT NOT NULL CHECK (state IN (
              'created', 'awaiting_filter_confirmation', 'opening_job_page', 'awaiting_login',
              'applying_filters', 'extracting_jobs', 'matching_jobs', 'awaiting_job_selection',
              'selected', 'converted_to_application', 'awaiting_challenge', 'paused', 'failed',
              'cancelled', 'expired'
            )),
            entry_kind TEXT CHECK (entry_kind IS NULL OR entry_kind IN ('job_list', 'job_detail', 'application_form')),
            source TEXT CHECK (source IS NULL OR source IN ('moka', 'dji', 'baidu')),
            initial_url TEXT NOT NULL,
            adapter_version TEXT,
            scoring_version TEXT NOT NULL DEFAULT 'job-match-v1' CHECK (scoring_version = 'job-match-v1'),
            profile_revision INTEGER NOT NULL CHECK (profile_revision >= 0),
            expectation_revision INTEGER NOT NULL CHECK (expectation_revision >= 0),
            execution_epoch INTEGER NOT NULL DEFAULT 0 CHECK (execution_epoch >= 0),
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
          INSERT INTO job_match_sessions_source_new SELECT * FROM job_match_sessions;
          DROP TABLE job_match_sessions;
          ALTER TABLE job_match_sessions_source_new RENAME TO job_match_sessions;
          CREATE UNIQUE INDEX job_match_sessions_selection_idempotency_unique
            ON job_match_sessions(selection_idempotency_key) WHERE selection_idempotency_key IS NOT NULL;
          CREATE UNIQUE INDEX job_match_sessions_conversion_idempotency_unique
            ON job_match_sessions(conversion_idempotency_key) WHERE conversion_idempotency_key IS NOT NULL;
        `);
      }

      if (postingNeedsUpgrade) {
        database.exec(`
          CREATE TABLE job_postings_source_new (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES job_match_sessions(id) ON DELETE CASCADE,
            source TEXT NOT NULL CHECK (source IN ('moka', 'dji', 'baidu')),
            source_job_id TEXT,
            canonical_url TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
            extracted_at TEXT NOT NULL
          );
          INSERT INTO job_postings_source_new SELECT * FROM job_postings;
          DROP TABLE job_postings;
          ALTER TABLE job_postings_source_new RENAME TO job_postings;
          CREATE UNIQUE INDEX job_postings_session_url_hash_unique
            ON job_postings(session_id, source, canonical_url, content_hash);
          CREATE UNIQUE INDEX job_postings_session_source_id_hash_unique
            ON job_postings(session_id, source, source_job_id, content_hash) WHERE source_job_id IS NOT NULL;
          CREATE INDEX job_postings_session_id_idx ON job_postings(session_id, id);
        `);
      }
    });
    upgrade();
  } finally {
    if (foreignKeysWereEnabled) database.pragma("foreign_keys = ON");
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
