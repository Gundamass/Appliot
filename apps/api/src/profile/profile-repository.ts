import { randomUUID } from "node:crypto";
import { ProfileFactSchema, type Evidence, type JsonValue, type ProfileFact } from "@resume/contracts";
import type { SqliteDatabase } from "../db/client.js";

interface FactRow {
  id: string;
  field_path: string;
  value_json: string;
  status: ProfileFact["status"];
  confidence: number;
  scope: ProfileFact["scope"];
  task_id: string | null;
  evidence_json: string;
  revision: number;
}

interface ApplicationAnswerRow {
  id: string;
  task_id: string;
  field_path: string;
  value_json: string;
  evidence_json: string;
  confidence: number;
}

export interface ProfileRepository {
  transaction<T>(operation: () => T): T;
  createExtracted(fact: ProfileFact): ProfileFact;
  confirm(factId: string): ProfileFact;
  correct(factId: string, value: JsonValue, evidence: Evidence[]): ProfileFact;
  putTaskAnswer(taskId: string, fieldPath: string, value: JsonValue, evidence: Evidence[]): ProfileFact;
  resolveForTask(taskId: string, fieldPath: string): ProfileFact | undefined;
  listActive(): ProfileFact[];
  getById(factId: string): ProfileFact | undefined;
  history(factId: string): ProfileFact[];
}

export interface ProfileRepositoryOptions {
  afterSnapshot?: () => void;
}

function now(): string {
  return new Date().toISOString();
}

function parseFact(row: FactRow): ProfileFact {
  return ProfileFactSchema.parse({
    id: row.id,
    fieldPath: row.field_path,
    value: JSON.parse(row.value_json),
    status: row.status,
    confidence: row.confidence,
    scope: row.scope,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    evidence: JSON.parse(row.evidence_json),
    revision: row.revision
  });
}

function parseApplicationAnswer(row: ApplicationAnswerRow): ProfileFact {
  return ProfileFactSchema.parse({
    id: row.id,
    fieldPath: row.field_path,
    value: JSON.parse(row.value_json),
    status: "user_confirmed",
    confidence: row.confidence,
    scope: "application",
    taskId: row.task_id,
    evidence: JSON.parse(row.evidence_json),
    revision: 1
  });
}

export function createProfileRepository(database: SqliteDatabase, options: ProfileRepositoryOptions = {}): ProfileRepository {
  const findFact = database.prepare("SELECT * FROM profile_facts WHERE id = ?");
  const insertFact = database.prepare(`
    INSERT INTO profile_facts (
      id, field_path, value_json, status, confidence, scope, task_id, evidence_json, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStatus = database.prepare("UPDATE profile_facts SET status = ?, updated_at = ? WHERE id = ?");
  const insertRevision = database.prepare(`
    INSERT INTO fact_revisions (
      id, fact_id, field_path, value_json, status, confidence, scope, task_id, evidence_json, revision, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateFact = database.prepare(`
    UPDATE profile_facts
    SET value_json = ?, status = 'user_corrected', confidence = 1, evidence_json = ?, revision = ?, updated_at = ?
    WHERE id = ?
  `);
  const findReviewedAlternatives = database.prepare(`
    SELECT * FROM profile_facts
    WHERE scope = 'profile' AND field_path = ? AND id != ? AND status IN ('user_confirmed', 'user_corrected')
  `);
  const supersedeFact = database.prepare(`
    UPDATE profile_facts SET status = 'superseded', revision = ?, updated_at = ? WHERE id = ?
  `);
  const findTaskAnswer = database.prepare(
    "SELECT * FROM application_answers WHERE task_id = ? AND field_path = ?"
  );
  const insertTaskAnswer = database.prepare(`
    INSERT INTO application_answers (
      id, task_id, field_path, value_json, evidence_json, confidence, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, field_path) DO UPDATE SET
      id = excluded.id,
      value_json = excluded.value_json,
      evidence_json = excluded.evidence_json,
      confidence = excluded.confidence,
      updated_at = excluded.updated_at
  `);

  const requireFact = (factId: string): ProfileFact => {
    const row = findFact.get(factId) as FactRow | undefined;
    if (!row) throw new Error(`profile fact not found: ${factId}`);
    return parseFact(row);
  };

  const snapshot = (fact: ProfileFact, timestamp: string): void => {
    insertRevision.run(
      randomUUID(),
      fact.id,
      fact.fieldPath,
      JSON.stringify(fact.value),
      fact.status,
      fact.confidence,
      fact.scope,
      fact.taskId ?? null,
      JSON.stringify(fact.evidence),
      fact.revision,
      timestamp
    );
  };

  const supersedeReviewedAlternatives = (fact: ProfileFact, timestamp: string): void => {
    if (fact.scope !== "profile") return;
    const alternatives = findReviewedAlternatives.all(fact.fieldPath, fact.id) as FactRow[];
    for (const alternative of alternatives.map(parseFact)) {
      snapshot(alternative, timestamp);
      supersedeFact.run(alternative.revision + 1, timestamp, alternative.id);
    }
  };

  return {
    transaction(operation) {
      return database.transaction(operation)();
    },
    createExtracted(fact) {
      const parsed = ProfileFactSchema.parse(fact);
      if (parsed.status !== "extracted") throw new Error("createExtracted requires an extracted fact");
      const timestamp = now();
      insertFact.run(
        parsed.id,
        parsed.fieldPath,
        JSON.stringify(parsed.value),
        parsed.status,
        parsed.confidence,
        parsed.scope,
        parsed.taskId ?? null,
        JSON.stringify(parsed.evidence),
        parsed.revision,
        timestamp,
        timestamp
      );
      return parsed;
    },

    confirm(factId) {
      return database.transaction(() => {
        const current = requireFact(factId);
        if (current.status === "superseded") throw new Error(`cannot confirm superseded fact: ${factId}`);
        if (current.status === "user_confirmed" || current.status === "user_corrected") return current;
        const timestamp = now();
        updateStatus.run("user_confirmed", timestamp, factId);
        const confirmed = { ...current, status: "user_confirmed" as const };
        supersedeReviewedAlternatives(confirmed, timestamp);
        return confirmed;
      })();
    },

    correct(factId, value, evidence) {
      return database.transaction(() => {
        const current = requireFact(factId);
        if (current.status === "superseded") throw new Error(`cannot correct superseded fact: ${factId}`);
        const nextRevision = current.revision + 1;
        const timestamp = now();
        const corrected = ProfileFactSchema.parse({
          ...current,
          value,
          evidence,
          status: "user_corrected",
          confidence: 1,
          revision: nextRevision
        });
        snapshot(current, timestamp);
        options.afterSnapshot?.();
        updateFact.run(JSON.stringify(value), JSON.stringify(evidence), nextRevision, timestamp, factId);
        supersedeReviewedAlternatives(corrected, timestamp);
        return corrected;
      })();
    },

    putTaskAnswer(taskId, fieldPath, value, evidence) {
      const timestamp = now();
      const fact = ProfileFactSchema.parse({
        id: randomUUID(),
        fieldPath,
        value,
        status: "user_confirmed",
        confidence: 1,
        scope: "application",
        taskId,
        evidence,
        revision: 1
      });
      insertTaskAnswer.run(
        fact.id,
        taskId,
        fieldPath,
        JSON.stringify(value),
        JSON.stringify(evidence),
        fact.confidence,
        timestamp,
        timestamp
      );
      const stored = findTaskAnswer.get(taskId, fieldPath) as ApplicationAnswerRow;
      return parseApplicationAnswer(stored);
    },

    resolveForTask(taskId, fieldPath) {
      const answer = findTaskAnswer.get(taskId, fieldPath) as ApplicationAnswerRow | undefined;
      if (answer) return parseApplicationAnswer(answer);
      const row = database.prepare(`
        SELECT * FROM profile_facts
        WHERE scope = 'profile' AND field_path = ? AND status IN ('user_corrected', 'user_confirmed')
        ORDER BY CASE status WHEN 'user_corrected' THEN 0 ELSE 1 END, revision DESC, updated_at DESC, id ASC
        LIMIT 1
      `).get(fieldPath) as FactRow | undefined;
      return row ? parseFact(row) : undefined;
    },

    listActive() {
      const rows = database.prepare(`
        SELECT * FROM profile_facts
        WHERE status != 'superseded'
        ORDER BY field_path, revision
      `).all() as FactRow[];
      return rows.map(parseFact);
    },

    getById(factId) {
      const row = findFact.get(factId) as FactRow | undefined;
      return row ? parseFact(row) : undefined;
    },

    history(factId) {
      requireFact(factId);
      const rows = database.prepare(`
        SELECT fact_id AS id, field_path, value_json, status, confidence, scope, task_id, evidence_json, revision
        FROM fact_revisions WHERE fact_id = ?
        UNION ALL
        SELECT id, field_path, value_json, status, confidence, scope, task_id, evidence_json, revision
        FROM profile_facts WHERE id = ?
        ORDER BY revision
      `).all(factId, factId) as FactRow[];
      return rows.map(parseFact);
    }
  };
}
