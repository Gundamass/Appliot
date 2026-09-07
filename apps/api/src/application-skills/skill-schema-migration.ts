import type { SqliteDatabase } from "../db/client.js";

const APPLICATION_SKILL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS skill_versions (
    skill_id TEXT NOT NULL,
    version TEXT NOT NULL,
    parent_version TEXT,
    schema_version INTEGER NOT NULL,
    content_hash TEXT NOT NULL UNIQUE,
    site TEXT NOT NULL,
    allowed_domains_json TEXT NOT NULL,
    page_fingerprint_rule_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'candidate', 'replay_qualified', 'challenger', 'champion', 'retired', 'quarantined'
    )),
    content_json TEXT NOT NULL,
    created_by_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (skill_id, version),
    UNIQUE (skill_id, version, site),
    FOREIGN KEY (skill_id, parent_version)
      REFERENCES skill_versions(skill_id, version) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS skill_page_bindings (
    skill_id TEXT NOT NULL,
    version TEXT NOT NULL,
    site TEXT NOT NULL,
    page_fingerprint_hash TEXT NOT NULL,
    allocation_id TEXT NOT NULL,
    active_status TEXT CHECK (active_status IN ('challenger', 'champion')),
    bound_at TEXT NOT NULL,
    PRIMARY KEY (site, page_fingerprint_hash, skill_id, version),
    FOREIGN KEY (skill_id, version, site)
      REFERENCES skill_versions(skill_id, version, site) ON DELETE RESTRICT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS skill_page_bindings_active_status_unique
  ON skill_page_bindings(site, page_fingerprint_hash, active_status)
  WHERE active_status IN ('challenger', 'champion');

  CREATE TRIGGER IF NOT EXISTS skill_page_bindings_version_scope_insert
  BEFORE INSERT ON skill_page_bindings
  WHEN EXISTS (
    SELECT 1 FROM skill_page_bindings
    WHERE skill_id = NEW.skill_id AND version = NEW.version
      AND (site <> NEW.site OR page_fingerprint_hash <> NEW.page_fingerprint_hash)
  )
  BEGIN
    SELECT RAISE(ABORT, 'skill_version_page_binding_conflict');
  END;

  CREATE TRIGGER IF NOT EXISTS skill_page_bindings_allocation_scope_insert
  BEFORE INSERT ON skill_page_bindings
  WHEN EXISTS (
    SELECT 1 FROM skill_page_bindings
    WHERE allocation_id = NEW.allocation_id
      AND (site <> NEW.site OR page_fingerprint_hash <> NEW.page_fingerprint_hash)
  )
  BEGIN
    SELECT RAISE(ABORT, 'skill_allocation_scope_mismatch');
  END;

  CREATE TABLE IF NOT EXISTS skill_traffic_allocations (
    allocation_id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    site TEXT NOT NULL,
    page_fingerprint_hash TEXT NOT NULL,
    champion_version TEXT NOT NULL,
    challenger_version TEXT,
    champion_percent INTEGER NOT NULL CHECK (champion_percent BETWEEN 0 AND 100),
    challenger_percent INTEGER NOT NULL CHECK (challenger_percent BETWEEN 0 AND 100),
    updated_at TEXT NOT NULL,
    UNIQUE (site, page_fingerprint_hash),
    CHECK (champion_percent + challenger_percent = 100),
    CHECK (
      (challenger_version IS NULL AND challenger_percent = 0)
      OR (challenger_version IS NOT NULL AND challenger_percent > 0)
    ),
    FOREIGN KEY (skill_id, champion_version, site)
      REFERENCES skill_versions(skill_id, version, site) ON DELETE RESTRICT,
    FOREIGN KEY (skill_id, challenger_version, site)
      REFERENCES skill_versions(skill_id, version, site) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS skill_execution_records (
    record_id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    version TEXT NOT NULL,
    site TEXT NOT NULL,
    page_fingerprint_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (skill_id, version, site)
      REFERENCES skill_versions(skill_id, version, site) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS skill_evaluations (
    evaluation_id TEXT PRIMARY KEY,
    execution_record_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    evaluated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (execution_record_id)
      REFERENCES skill_execution_records(record_id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS skill_evolution_runs (
    run_id TEXT PRIMARY KEY,
    trigger TEXT NOT NULL,
    input_record_ids_json TEXT NOT NULL,
    candidate_skill_id TEXT,
    candidate_version TEXT,
    final_status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skill_replay_samples (
    sample_id TEXT PRIMARY KEY,
    site TEXT NOT NULL,
    page_fingerprint_hash TEXT NOT NULL,
    split TEXT NOT NULL CHECK (split IN ('train', 'holdout')),
    redacted_snapshot_json TEXT NOT NULL,
    expected_actions_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skill_replay_run_samples (
    replay_run_id TEXT NOT NULL,
    sample_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    version TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'equal')),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (replay_run_id, sample_id, skill_id, version),
    FOREIGN KEY (sample_id)
      REFERENCES skill_replay_samples(sample_id) ON DELETE RESTRICT,
    FOREIGN KEY (skill_id, version)
      REFERENCES skill_versions(skill_id, version) ON DELETE RESTRICT
  );

  CREATE TRIGGER IF NOT EXISTS skill_versions_immutable_update
  BEFORE UPDATE OF
    skill_id, version, parent_version, schema_version, content_hash, site,
    allowed_domains_json, page_fingerprint_rule_json, content_json,
    created_by_json, created_at
  ON skill_versions
  BEGIN
    SELECT RAISE(ABORT, 'skill_version_is_immutable');
  END;

  DROP TRIGGER IF EXISTS skill_versions_status_transition_guard;

  CREATE TRIGGER skill_versions_status_transition_guard
  BEFORE UPDATE OF status ON skill_versions
  WHEN NEW.status <> OLD.status AND NOT (
    (OLD.status = 'candidate' AND NEW.status = 'replay_qualified')
    OR (OLD.status = 'replay_qualified' AND NEW.status = 'challenger')
    OR (OLD.status = 'challenger' AND NEW.status = 'champion')
    OR (OLD.status = 'challenger' AND NEW.status = 'retired')
    OR (OLD.status = 'champion' AND NEW.status = 'retired')
    OR (OLD.status = 'retired' AND NEW.status = 'champion')
    OR (OLD.status <> 'retired' AND OLD.status <> 'quarantined' AND NEW.status = 'quarantined')
  )
  BEGIN
    SELECT RAISE(ABORT, 'skill_status_transition_invalid');
  END;

  CREATE TRIGGER IF NOT EXISTS skill_versions_no_delete
  BEFORE DELETE ON skill_versions
  BEGIN
    SELECT RAISE(ABORT, 'skill_version_delete_forbidden');
  END;

  CREATE TRIGGER IF NOT EXISTS skill_page_bindings_immutable_update
  BEFORE UPDATE OF skill_id, version, site, page_fingerprint_hash, allocation_id, bound_at
  ON skill_page_bindings
  BEGIN
    SELECT RAISE(ABORT, 'skill_page_binding_is_immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS skill_page_bindings_no_delete
  BEFORE DELETE ON skill_page_bindings
  BEGIN
    SELECT RAISE(ABORT, 'skill_page_binding_delete_forbidden');
  END;
`;

const APPEND_ONLY_TABLES = [
  "skill_execution_records",
  "skill_evaluations",
  "skill_evolution_runs",
  "skill_replay_samples",
  "skill_replay_run_samples"
] as const;

export function migrateApplicationSkillSchema(database: SqliteDatabase): void {
  const migrate = database.transaction(() => {
    database.exec(APPLICATION_SKILL_SCHEMA);
    for (const table of APPEND_ONLY_TABLES) {
      database.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_append_only_update
        BEFORE UPDATE ON ${table}
        BEGIN
          SELECT RAISE(ABORT, '${table}_is_append_only');
        END;

        CREATE TRIGGER IF NOT EXISTS ${table}_append_only_delete
        BEFORE DELETE ON ${table}
        BEGIN
          SELECT RAISE(ABORT, '${table}_is_append_only');
        END;
      `);
    }
  });

  migrate.immediate();
}
