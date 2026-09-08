import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ApplicationFieldCoverageSchema,
  HumanInterruptSchema,
  SkillBindingSchema,
  SkillTraceDimensionsSchema,
  type ApplicationFieldCoverage,
  type HumanInterrupt,
  type SkillBinding
} from "@resume/contracts";
import type { SqliteDatabase } from "../../db/client.js";

const MAX_STATE_BYTES = 128 * 1024;
const MAX_TRACKED_IDS = 500;

const RuntimeFieldAssessmentSchema = z.object({
  fieldId: z.string().min(1).max(128),
  label: z.string().min(1).max(500),
  semantic: z.string().min(1).max(512).optional(),
  status: z.enum(["ready", "review", "missing", "unsupported", "filled", "failed"]),
  source: z.enum(["dji_catalog", "exact", "semantic", "user", "none"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(2_000),
  evidenceRefs: z.array(z.string().regex(/^evidence[:_][a-f0-9]{64}$/iu)).max(50)
}).strict();

export const RuntimeApplicationFieldCoverageSchema = z.object({
  total: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  filled: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  fields: z.array(RuntimeFieldAssessmentSchema).max(MAX_TRACKED_IDS)
}).strict();

export type RuntimeApplicationFieldCoverage = z.infer<typeof RuntimeApplicationFieldCoverageSchema>;

const RuntimeApplicationPendingInterruptSchema = HumanInterruptSchema.extend({
  runId: z.string().min(1).max(128).optional(),
  taskId: z.string().min(1).max(128).optional(),
  stepId: z.string().min(1).max(128).optional(),
  planRevision: z.number().int().positive().optional(),
  executionEpoch: z.number().int().nonnegative().optional(),
  snapshotId: z.string().min(1).max(256).optional(),
  targetFingerprint: z.string().min(1).max(256).optional(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/iu).optional(),
  safetyStateRef: z.string().min(1).max(512).optional()
}).strict();

export type RuntimeApplicationPendingInterrupt = z.infer<typeof RuntimeApplicationPendingInterruptSchema>;

const RuntimeApplicationStateShape = {
  runId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  applicationUrl: z.string().url().max(2_000),
  snapshotId: z.string().min(1).max(256).optional(),
  executionEpoch: z.number().int().nonnegative(),
  fieldIds: z.array(z.string().min(1).max(256)).max(MAX_TRACKED_IDS).optional(),
  plannedCommandIds: z.array(z.string().min(1).max(128)).max(MAX_TRACKED_IDS),
  completedCommandIds: z.array(z.string().min(1).max(128)).max(MAX_TRACKED_IDS),
  retryCount: z.number().int().nonnegative().max(64),
  finalReviewLocked: z.boolean(),
  fieldCoverage: RuntimeApplicationFieldCoverageSchema.optional(),
  pendingInterrupt: RuntimeApplicationPendingInterruptSchema.optional(),
  updatedAt: z.string().datetime()
};

const LegacyRuntimeApplicationStateSchema = z.object({
  version: z.literal("1.0.0"),
  ...RuntimeApplicationStateShape
}).strict();

export const CurrentRuntimeApplicationStateSchema = z.object({
  version: z.literal("1.1.0"),
  ...RuntimeApplicationStateShape,
  skillBinding: SkillBindingSchema.optional(),
  skillTrace: SkillTraceDimensionsSchema.optional()
}).strict();

export const RuntimeApplicationStateSchema = z.discriminatedUnion("version", [
  LegacyRuntimeApplicationStateSchema,
  CurrentRuntimeApplicationStateSchema
]);

export type RuntimeApplicationState = z.infer<typeof CurrentRuntimeApplicationStateSchema>;

/**
 * Converts the UI-facing coverage (which may contain evidence quotations) to
 * a checkpoint-safe projection. Only deterministic evidence IDs cross the
 * Runtime persistence boundary; evidence text and form values stay outside it.
 */
export function redactFieldCoverage(coverage: ApplicationFieldCoverage): RuntimeApplicationFieldCoverage {
  const parsed = ApplicationFieldCoverageSchema.parse(coverage);
  return RuntimeApplicationFieldCoverageSchema.parse({
    ...parsed,
    fields: parsed.fields.map(({ evidence, ...field }) => ({
      ...field,
      evidenceRefs: [...new Set(evidence.map(coverageEvidenceId))].slice(0, 50)
    }))
  });
}

/** Rehydrates a safe UI projection; referenced evidence is resolved separately by the evidence store. */
export function restoreFieldCoverage(coverage: RuntimeApplicationFieldCoverage): ApplicationFieldCoverage {
  const parsed = RuntimeApplicationFieldCoverageSchema.parse(coverage);
  return ApplicationFieldCoverageSchema.parse({
    ...parsed,
    fields: parsed.fields.map(({ evidenceRefs: _evidenceRefs, ...field }) => ({
      ...field,
      evidence: []
    }))
  });
}

/**
 * A tiny persistence boundary for application-specialist metadata. The
 * boundary intentionally accepts only validated metadata; DOM snapshots,
 * form values, files, credentials and tokens have no representable field.
 */
export interface RuntimeApplicationStatePersistence {
  save(state: RuntimeApplicationState): void;
  get(runId: string): RuntimeApplicationState | undefined;
  delete(runId: string): void;
  list(): RuntimeApplicationState[];
}

export interface RuntimeApplicationStateStore {
  save(state: unknown): Promise<RuntimeApplicationState>;
  get(runId: string): Promise<RuntimeApplicationState | undefined>;
  delete(runId: string): Promise<void>;
  list(): Promise<RuntimeApplicationState[]>;
  /** Atomically pins the first valid Skill binding for this run/task pair. */
  bindSkill(runId: string, taskId: string, binding: unknown): Promise<SkillBinding>;
  /** Returns the backing adapter so a fresh store can be created after restart. */
  persistence(): RuntimeApplicationStatePersistence;
}

export function createRuntimeApplicationStateStore(
  databaseOrPersistence?: SqliteDatabase | RuntimeApplicationStatePersistence
): RuntimeApplicationStateStore {
  const persistence = databaseOrPersistence === undefined
    ? createInMemoryPersistence()
    : isPersistence(databaseOrPersistence)
      ? databaseOrPersistence
      : createSqlitePersistence(databaseOrPersistence);

  return {
    async save(value) {
      const state = parseState(value);
      persistence.save(state);
      return clone(state);
    },
    async get(runId) {
      const value = persistence.get(assertRunId(runId));
      return value === undefined ? undefined : clone(parseState(value));
    },
    async delete(runId) {
      persistence.delete(assertRunId(runId));
    },
    async list() {
      return persistence.list().map((value) => clone(parseState(value)));
    },
    async bindSkill(runId, taskId, value) {
      const safeRunId = assertRunId(runId);
      const binding = SkillBindingSchema.parse(value);
      const currentValue = persistence.get(safeRunId);
      if (currentValue === undefined) throw new Error("runtime_application_state_not_found");
      const current = parseState(currentValue);
      if (current.taskId !== taskId) throw new Error("runtime_application_state_identity_mismatch");
      if (current.skillBinding !== undefined) return structuredClone(current.skillBinding);
      const next = parseState({
        ...current,
        skillBinding: binding,
        updatedAt: new Date().toISOString()
      });
      // Persistence adapters are synchronous; this read-check-write completes
      // without an event-loop yield, so concurrent first callers observe one winner.
      persistence.save(next);
      return structuredClone(binding);
    },
    persistence() {
      return persistence;
    }
  };
}

export function createInMemoryPersistence(): RuntimeApplicationStatePersistence {
  const states = new Map<string, RuntimeApplicationState>();
  return {
    save(state) {
      states.set(state.runId, clone(state));
    },
    get(runId) {
      const state = states.get(runId);
      return state === undefined ? undefined : clone(state);
    },
    delete(runId) {
      states.delete(runId);
    },
    list() {
      return [...states.values()].map(clone);
    }
  };
}

function createSqlitePersistence(database: SqliteDatabase): RuntimeApplicationStatePersistence {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_runtime_application_states (
      run_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_runtime_application_states_updated_idx
      ON agent_runtime_application_states(updated_at, run_id);
  `);
  const upsert = database.prepare(`
    INSERT INTO agent_runtime_application_states (run_id, payload_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);
  const find = database.prepare(
    "SELECT payload_json FROM agent_runtime_application_states WHERE run_id = ?"
  );
  const findAll = database.prepare(
    "SELECT payload_json FROM agent_runtime_application_states ORDER BY updated_at ASC, run_id ASC"
  );
  const remove = database.prepare("DELETE FROM agent_runtime_application_states WHERE run_id = ?");

  return {
    save(state) {
      upsert.run(state.runId, JSON.stringify(state), state.updatedAt);
    },
    get(runId) {
      const row = find.get(runId) as { payload_json: string } | undefined;
      return row === undefined ? undefined : parseStored(row.payload_json);
    },
    delete(runId) {
      remove.run(runId);
    },
    list() {
      return (findAll.all() as Array<{ payload_json: string }>).map((row) => parseStored(row.payload_json));
    }
  };
}

function parseState(value: unknown): RuntimeApplicationState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runtime_application_state_invalid");
  }
  const parsed = RuntimeApplicationStateSchema.safeParse(value);
  if (!parsed.success) {
    const hasUnknown = parsed.error.issues.some((issue) => issue.code === "unrecognized_keys");
    throw new Error(hasUnknown ? "runtime_application_state_unknown_field" : "runtime_application_state_invalid");
  }
  scanSensitive(parsed.data);
  if (parsed.data.version === "1.1.0" && parsed.data.skillTrace !== undefined) {
    const binding = parsed.data.skillBinding;
    if (binding === undefined
      || parsed.data.skillTrace.skillId !== binding.skillId
      || parsed.data.skillTrace.skillVersion !== binding.version
      || parsed.data.skillTrace.pageFingerprintHash !== binding.pageFingerprintHash) {
      throw new Error("runtime_application_skill_trace_mismatch");
    }
  }
  if (JSON.stringify(parsed.data).length > MAX_STATE_BYTES) {
    throw new Error("runtime_application_state_too_large");
  }
  if (parsed.data.version === "1.1.0") return parsed.data;
  const { version: _legacyVersion, ...legacy } = parsed.data;
  return CurrentRuntimeApplicationStateSchema.parse({ version: "1.1.0", ...legacy });
}

function parseStored(payload: string): RuntimeApplicationState {
  try {
    return parseState(JSON.parse(payload));
  } catch {
    throw new Error("runtime_application_state_corrupt");
  }
}

function scanSensitive(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    value.forEach(scanSensitive);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:cookie|password|passwd|token|secret|authorization|credential|prompt|playwright|page[_-]?handle|full[_-]?dom|html|binary|value)/iu.test(key)) {
      throw new Error("runtime_application_state_sensitive_field");
    }
    scanSensitive(nested);
  }
}

function isPersistence(value: SqliteDatabase | RuntimeApplicationStatePersistence): value is RuntimeApplicationStatePersistence {
  return typeof (value as RuntimeApplicationStatePersistence).save === "function"
    && typeof (value as RuntimeApplicationStatePersistence).get === "function"
    && typeof (value as RuntimeApplicationStatePersistence).list === "function";
}

function assertRunId(runId: string): string {
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 128) {
    throw new Error("agent_run_id_required");
  }
  return runId;
}

function clone(state: RuntimeApplicationState): RuntimeApplicationState {
  return JSON.parse(JSON.stringify(state)) as RuntimeApplicationState;
}

function coverageEvidenceId(evidence: ApplicationFieldCoverage["fields"][number]["evidence"][number]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([evidence.documentId, evidence.page, evidence.extraction, evidence.text]))
    .digest("hex");
  return `evidence:${digest}`;
}

export type RuntimeApplicationInterrupt = HumanInterrupt;
