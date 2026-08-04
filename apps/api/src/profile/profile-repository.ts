import { randomUUID } from "node:crypto";
import {
  ProfileFactSchema,
  ProfileFactUpsertInputSchema,
  type Evidence,
  type JsonValue,
  type ProfileFact,
  type ProfileFactUpsertInput
} from "@resume/contracts";
import { semanticLookupPaths } from "@resume/form-semantics";
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
  upsertUserFact(input: ProfileFactUpsertInput): ProfileFact;
  removeProfileFacts(fieldPaths: string[]): number;
  confirm(factId: string): ProfileFact;
  correct(factId: string, value: JsonValue, evidence: Evidence[]): ProfileFact;
  putTaskAnswer(taskId: string, fieldPath: string, value: JsonValue, evidence: Evidence[]): ProfileFact;
  resolveForTask(taskId: string, fieldPath: string): ProfileFact | undefined;
  listActive(): ProfileFact[];
  listForTask(taskId: string): ProfileFact[];
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

function withRequestedFieldPath(fact: ProfileFact, fieldPath: string): ProfileFact {
  return fact.fieldPath === fieldPath ? fact : { ...fact, fieldPath };
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
  const findProfileFact = database.prepare(`
    SELECT * FROM profile_facts
    WHERE scope = 'profile' AND field_path = ? AND status IN ('user_corrected', 'user_confirmed')
    ORDER BY CASE status WHEN 'user_corrected' THEN 0 ELSE 1 END, revision DESC, updated_at DESC, id ASC
    LIMIT 1
  `);
  const findReviewedProfileFacts = database.prepare(`
    SELECT * FROM profile_facts
    WHERE scope = 'profile' AND field_path = ? AND status IN ('user_confirmed', 'user_corrected')
  `);
  const findActiveProfileFacts = database.prepare(`
    SELECT * FROM profile_facts
    WHERE scope = 'profile' AND field_path = ? AND status != 'superseded'
  `);
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
  const deleteTaskAnswer = database.prepare(
    "DELETE FROM application_answers WHERE task_id = ? AND field_path = ?"
  );

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
    const alternatives = new Map<string, ProfileFact>();
    for (const fieldPath of semanticLookupPaths(fact.fieldPath)) {
      for (const row of findReviewedAlternatives.all(fieldPath, fact.id) as FactRow[]) {
        alternatives.set(row.id, parseFact(row));
      }
    }
    for (const alternative of alternatives.values()) {
      snapshot(alternative, timestamp);
      supersedeFact.run(alternative.revision + 1, timestamp, alternative.id);
    }
  };

  const findReviewedProfileFact = (fieldPath: string): ProfileFact | undefined => {
    const candidates = new Map<string, ProfileFact>();
    for (const lookupPath of semanticLookupPaths(fieldPath)) {
      for (const row of findReviewedProfileFacts.all(lookupPath) as FactRow[]) {
        candidates.set(row.id, parseFact(row));
      }
    }
    return [...candidates.values()].sort((left, right) => {
      const statusDifference = Number(right.status === "user_corrected") - Number(left.status === "user_corrected");
      if (statusDifference !== 0) return statusDifference;
      if (right.revision !== left.revision) return right.revision - left.revision;
      return left.id.localeCompare(right.id);
    })[0];
  };

  const correctStoredFact = (factId: string, value: JsonValue, evidence: Evidence[]): ProfileFact => {
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

    upsertUserFact(input) {
      const parsed = ProfileFactUpsertInputSchema.parse(input);
      const evidence: Evidence[] = [{
        documentId: "user",
        page: 1,
        text: `用户补充：${parsed.fieldPath}`,
        extraction: "user"
      }];
      return database.transaction(() => {
        const existing = findReviewedProfileFact(parsed.fieldPath);
        if (existing) return correctStoredFact(existing.id, parsed.value, evidence);

        const timestamp = now();
        const created = ProfileFactSchema.parse({
          id: randomUUID(),
          fieldPath: parsed.fieldPath,
          value: parsed.value,
          status: "user_corrected",
          confidence: 1,
          scope: "profile",
          evidence,
          revision: 1
        });
        insertFact.run(
          created.id,
          created.fieldPath,
          JSON.stringify(created.value),
          created.status,
          created.confidence,
          created.scope,
          null,
          JSON.stringify(created.evidence),
          created.revision,
          timestamp,
          timestamp
        );
        supersedeReviewedAlternatives(created, timestamp);
        return created;
      })();
    },

    removeProfileFacts(fieldPaths) {
      return database.transaction(() => {
        const matches = new Map<string, ProfileFact>();
        for (const fieldPath of fieldPaths) {
          for (const lookupPath of semanticLookupPaths(fieldPath)) {
            for (const row of findActiveProfileFacts.all(lookupPath) as FactRow[]) {
              const fact = parseFact(row);
              matches.set(fact.id, fact);
            }
          }
        }
        const timestamp = now();
        for (const fact of matches.values()) {
          snapshot(fact, timestamp);
          supersedeFact.run(fact.revision + 1, timestamp, fact.id);
        }
        return matches.size;
      })();
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
      return database.transaction(() => correctStoredFact(factId, value, evidence))();
    },

    putTaskAnswer(taskId, fieldPath, value, evidence) {
      return database.transaction(() => {
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
        for (const equivalentPath of semanticLookupPaths(fieldPath)) {
          if (equivalentPath !== fieldPath) deleteTaskAnswer.run(taskId, equivalentPath);
        }
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
      })();
    },

    resolveForTask(taskId, fieldPath) {
      const lookupPaths = semanticLookupPaths(fieldPath);
      for (const lookupPath of lookupPaths) {
        const answer = findTaskAnswer.get(taskId, lookupPath) as ApplicationAnswerRow | undefined;
        if (answer) return withRequestedFieldPath(parseApplicationAnswer(answer), fieldPath);
      }
      for (const lookupPath of lookupPaths) {
        const row = findProfileFact.get(lookupPath) as FactRow | undefined;
        if (!row) continue;
        return withRequestedFieldPath(parseFact(row), fieldPath);
      }
      return undefined;
    },

    listActive() {
      const rows = database.prepare(`
        SELECT * FROM profile_facts
        WHERE status != 'superseded'
        ORDER BY field_path, revision
      `).all() as FactRow[];
      return rows.map(parseFact);
    },

    listForTask(taskId) {
      const profile = database.prepare(`
        SELECT * FROM profile_facts
        WHERE scope = 'profile' AND status != 'superseded'
        ORDER BY field_path, revision, id
      `).all() as FactRow[];
      const answers = database.prepare(`
        SELECT * FROM application_answers
        WHERE task_id = ?
        ORDER BY field_path, id
      `).all(taskId) as ApplicationAnswerRow[];
      return [...profile.map(parseFact), ...answers.map(parseApplicationAnswer)];
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
