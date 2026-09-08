import { createHash } from "node:crypto";
import {
  EvidenceRefSchema,
  type EvidenceRef
} from "@resume/contracts";
import type { SqliteDatabase } from "../../db/client.js";

/**
 * Provenance attached to an evidence reference is deliberately metadata-only.
 * The referenced content remains in the owning document/observation store and
 * is never copied into Runtime checkpoints or Supervisor state.
 */
export interface EvidenceRegistration extends Omit<EvidenceRef, "id"> {
  readonly runId: string;
  readonly stepId: string;
  readonly invocationId: string;
}

export interface EvidenceRecord extends EvidenceRef {
  readonly runId: string;
  readonly stepId: string;
  readonly invocationId: string;
  readonly registeredAt: string;
}

export interface EvidenceValidationContext {
  readonly runId: string;
  readonly stepId: string;
  readonly invocationId?: string;
  readonly requiredKind?: EvidenceRef["kind"];
}

export type EvidenceValidation =
  | { readonly valid: true; readonly evidence: EvidenceRecord }
  | {
      readonly valid: false;
      readonly reason:
        | "evidence_not_registered"
        | "evidence_provenance_mismatch"
        | "evidence_kind_mismatch";
    };

export interface EvidenceStore {
  register(input: EvidenceRegistration): EvidenceRecord;
  get(id: string): EvidenceRecord | undefined;
  validate(id: string, context: EvidenceValidationContext): EvidenceValidation;
  has(id: string, context?: EvidenceValidationContext): boolean;
}

export function createInMemoryEvidenceStore(options: { now?: () => string } = {}): EvidenceStore {
  const now = options.now ?? (() => new Date().toISOString());
  const records = new Map<string, EvidenceRecord>();

  const store: EvidenceStore = {
    register(input) {
      assertNonEmpty(input.runId, "evidence_run_id_required");
      assertNonEmpty(input.stepId, "evidence_step_id_required");
      assertNonEmpty(input.invocationId, "evidence_invocation_id_required");
      const base = EvidenceRefSchema.parse({
        id: evidenceId(input),
        kind: input.kind,
        sourceRef: input.sourceRef,
        contentHash: input.contentHash,
        ...(input.locator === undefined ? {} : { locator: input.locator })
      });
      const record: EvidenceRecord = Object.freeze({
        ...base,
        runId: input.runId,
        stepId: input.stepId,
        invocationId: input.invocationId,
        registeredAt: now()
      });
      const existing = records.get(record.id);
      if (existing !== undefined) {
        if (existing.runId !== record.runId
          || existing.stepId !== record.stepId
          || existing.invocationId !== record.invocationId
          || existing.contentHash !== record.contentHash) {
          throw new Error("evidence_id_conflict");
        }
        return clone(existing);
      }
      records.set(record.id, record);
      return clone(record);
    },
    get(id) {
      const value = records.get(assertId(id));
      return value === undefined ? undefined : clone(value);
    },
    validate(id, context) {
      const value = records.get(assertId(id));
      if (value === undefined) return { valid: false, reason: "evidence_not_registered" };
      if (value.runId !== context.runId
        || value.stepId !== context.stepId
        || (context.invocationId !== undefined && value.invocationId !== context.invocationId)) {
        return { valid: false, reason: "evidence_provenance_mismatch" };
      }
      if (context.requiredKind !== undefined && value.kind !== context.requiredKind) {
        return { valid: false, reason: "evidence_kind_mismatch" };
      }
      return { valid: true, evidence: clone(value) };
    },
    has(id, context) {
      return context === undefined
        ? records.has(assertId(id))
        : store.validate(id, context).valid;
    }
  };
  return store;
}

export function createSqliteEvidenceStore(
  database: SqliteDatabase,
  options: { now?: () => string } = {}
): EvidenceStore {
  const now = options.now ?? (() => new Date().toISOString());
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_evidence_records (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      locator TEXT,
      registered_at TEXT NOT NULL,
      UNIQUE (run_id, step_id, invocation_id, kind, source_ref, content_hash, locator)
    );
    CREATE INDEX IF NOT EXISTS agent_evidence_records_provenance_idx
      ON agent_evidence_records(run_id, step_id, invocation_id);
  `);
  const find = database.prepare(`
    SELECT id, run_id, step_id, invocation_id, kind, source_ref, content_hash, locator, registered_at
    FROM agent_evidence_records WHERE id = ?
  `);
  const insert = database.prepare(`
    INSERT INTO agent_evidence_records
      (id, run_id, step_id, invocation_id, kind, source_ref, content_hash, locator, registered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const read = (id: string): EvidenceRecord | undefined => {
    const row = find.get(assertId(id)) as EvidenceRow | undefined;
    return row === undefined ? undefined : evidenceFromRow(row);
  };
  const store: EvidenceStore = {
    register(input) {
      assertNonEmpty(input.runId, "evidence_run_id_required");
      assertNonEmpty(input.stepId, "evidence_step_id_required");
      assertNonEmpty(input.invocationId, "evidence_invocation_id_required");
      const record = buildEvidenceRecord(input, now());
      const existing = read(record.id);
      if (existing !== undefined) {
        assertSameEvidence(existing, record);
        return clone(existing);
      }
      try {
        insert.run(
          record.id,
          record.runId,
          record.stepId,
          record.invocationId,
          record.kind,
          record.sourceRef,
          record.contentHash,
          record.locator ?? null,
          record.registeredAt
        );
      } catch {
        const raced = read(record.id);
        if (raced === undefined) throw new Error("evidence_id_conflict");
        assertSameEvidence(raced, record);
        return clone(raced);
      }
      return clone(record);
    },
    get(id) {
      return read(id);
    },
    validate(id, context) {
      const value = read(id);
      if (value === undefined) return { valid: false, reason: "evidence_not_registered" };
      return validateEvidence(value, context);
    },
    has(id, context) {
      return context === undefined ? read(id) !== undefined : store.validate(id, context).valid;
    }
  };
  return store;
}

interface EvidenceRow {
  id: string;
  run_id: string;
  step_id: string;
  invocation_id: string;
  kind: string;
  source_ref: string;
  content_hash: string;
  locator: string | null;
  registered_at: string;
}

function buildEvidenceRecord(input: EvidenceRegistration, registeredAt: string): EvidenceRecord {
  const base = EvidenceRefSchema.parse({
    id: evidenceId(input),
    kind: input.kind,
    sourceRef: input.sourceRef,
    contentHash: input.contentHash,
    ...(input.locator === undefined ? {} : { locator: input.locator })
  });
  return Object.freeze({
    ...base,
    runId: input.runId,
    stepId: input.stepId,
    invocationId: input.invocationId,
    registeredAt
  });
}

function evidenceFromRow(row: EvidenceRow): EvidenceRecord {
  const base = EvidenceRefSchema.parse({
    id: row.id,
    kind: row.kind,
    sourceRef: row.source_ref,
    contentHash: row.content_hash,
    ...(row.locator === null ? {} : { locator: row.locator })
  });
  return Object.freeze({
    ...base,
    runId: row.run_id,
    stepId: row.step_id,
    invocationId: row.invocation_id,
    registeredAt: row.registered_at
  });
}

function validateEvidence(value: EvidenceRecord, context: EvidenceValidationContext): EvidenceValidation {
  if (value.runId !== context.runId
    || value.stepId !== context.stepId
    || (context.invocationId !== undefined && value.invocationId !== context.invocationId)) {
    return { valid: false, reason: "evidence_provenance_mismatch" };
  }
  if (context.requiredKind !== undefined && value.kind !== context.requiredKind) {
    return { valid: false, reason: "evidence_kind_mismatch" };
  }
  return { valid: true, evidence: clone(value) };
}

function assertSameEvidence(left: EvidenceRecord, right: EvidenceRecord): void {
  if (left.runId !== right.runId
    || left.stepId !== right.stepId
    || left.invocationId !== right.invocationId
    || left.contentHash !== right.contentHash) {
    throw new Error("evidence_id_conflict");
  }
}

function evidenceId(input: EvidenceRegistration): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      input.runId,
      input.stepId,
      input.invocationId,
      input.kind,
      input.sourceRef,
      input.contentHash,
      input.locator ?? ""
    ]))
    .digest("hex");
  return `evidence:${digest}`;
}

function assertNonEmpty(value: string, code: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(code);
}

function assertId(value: string): string {
  assertNonEmpty(value, "evidence_id_required");
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
