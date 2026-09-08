import {
  RuntimeCheckpointSchema,
  type RuntimeCheckpoint
} from "@resume/contracts";
import type { SqliteDatabase } from "../../db/client.js";

const CHECKPOINT_VERSION = "2.0.0";
const MAX_CHECKPOINT_BYTES = 512 * 1024;
const TOP_LEVEL_FIELDS = new Set([
  "version", "runId", "intentId", "planId", "planRevision", "executionEpoch", "phase", "status",
  "currentStepId", "intentRef", "planRef", "memoryRefs", "evidenceRefs", "pendingInterrupt",
  "requestContextRef", "budget", "budgetLimits", "completedActionIds", "stateHash", "createdAt"
]);
const SENSITIVE_FIELD = /(?:cookie|password|passwd|token|secret|authorization|credential|raw[_-]?prompt|prompt|playwright|page[_-]?handle|full[_-]?dom|html|binary)/iu;

export interface RuntimeCheckpointStore {
  save(checkpoint: unknown): Promise<RuntimeCheckpoint>;
  latest(runId: string): Promise<RuntimeCheckpoint | undefined>;
  list(runId: string): Promise<RuntimeCheckpoint[]>;
}

interface CheckpointRow {
  run_id: string;
  payload_json: string;
}

export function createRuntimeCheckpointStore(database?: SqliteDatabase): RuntimeCheckpointStore {
  return database === undefined
    ? createInMemoryRuntimeCheckpointStore()
    : createSqliteRuntimeCheckpointStore(database);
}

export function createInMemoryRuntimeCheckpointStore(): RuntimeCheckpointStore {
  const checkpoints = new Map<string, RuntimeCheckpoint[]>();
  return {
    async save(checkpoint) {
      const parsed = parseCheckpoint(checkpoint);
      const current = checkpoints.get(parsed.runId) ?? [];
      current.push(clone(parsed));
      checkpoints.set(parsed.runId, current);
      return clone(parsed);
    },
    async latest(runId) {
      const current = checkpoints.get(assertRunId(runId));
      const value = current?.[current.length - 1];
      return value === undefined ? undefined : clone(value);
    },
    async list(runId) {
      return (checkpoints.get(assertRunId(runId)) ?? []).map(clone);
    }
  };
}

function createSqliteRuntimeCheckpointStore(database: SqliteDatabase): RuntimeCheckpointStore {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_runtime_checkpoints (
      run_id TEXT NOT NULL,
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_runtime_checkpoints_run_sequence_idx
      ON agent_runtime_checkpoints(run_id, sequence);
  `);
  const insert = database.prepare(`
    INSERT INTO agent_runtime_checkpoints (run_id, payload_json, created_at)
    VALUES (?, ?, ?)
  `);
  const latest = database.prepare(`
    SELECT run_id, payload_json FROM agent_runtime_checkpoints
    WHERE run_id = ? ORDER BY sequence DESC LIMIT 1
  `);
  const list = database.prepare(`
    SELECT run_id, payload_json FROM agent_runtime_checkpoints
    WHERE run_id = ? ORDER BY sequence ASC
  `);
  const save = database.transaction((checkpoint: RuntimeCheckpoint, payload: string) => {
    insert.run(checkpoint.runId, payload, checkpoint.createdAt);
  });

  return {
    async save(checkpoint) {
      const parsed = parseCheckpoint(checkpoint);
      const payload = JSON.stringify(parsed);
      save(parsed, payload);
      return clone(parsed);
    },
    async latest(runId) {
      const row = latest.get(assertRunId(runId)) as CheckpointRow | undefined;
      return row === undefined ? undefined : parseStored(row);
    },
    async list(runId) {
      return (list.all(assertRunId(runId)) as CheckpointRow[]).map(parseStored);
    }
  };
}

function parseStored(row: CheckpointRow): RuntimeCheckpoint {
  try {
    return parseCheckpoint(JSON.parse(row.payload_json));
  } catch {
    throw new Error("runtime_checkpoint_corrupt");
  }
}

function parseCheckpoint(value: unknown): RuntimeCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runtime_checkpoint_invalid");
  }
  const unknown = Object.keys(value).filter((key) => !TOP_LEVEL_FIELDS.has(key));
  if (unknown.length > 0) throw new Error("runtime_checkpoint_unknown_field");
  const parsed = RuntimeCheckpointSchema.parse(value);
  if (parsed.version !== CHECKPOINT_VERSION) throw new Error("runtime_checkpoint_version_unsupported");
  if (parsed.status === "interrupted" && parsed.pendingInterrupt === undefined) {
    throw new Error("runtime_checkpoint_interrupt_missing");
  }
  if (parsed.status !== "interrupted" && parsed.pendingInterrupt !== undefined) {
    throw new Error("runtime_checkpoint_interrupt_unexpected");
  }
  scanSensitive(parsed);
  const encoded = JSON.stringify(parsed);
  if (encoded.length > MAX_CHECKPOINT_BYTES) throw new Error("runtime_checkpoint_too_large");
  return parsed;
}

function scanSensitive(value: unknown, path = "checkpoint"): void {
  if (typeof value !== "object" || value === null) return;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    throw new Error(`runtime_checkpoint_binary:${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitive(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (
      SENSITIVE_FIELD.test(key)
      && !(path === "checkpoint.budget" && key === "tokens")
      && !(path === "checkpoint.budgetLimits" && key === "maxTokens")
    ) {
      throw new Error("runtime_checkpoint_sensitive_field");
    }
    scanSensitive(nested, `${path}.${key}`);
  }
}

function clone(value: RuntimeCheckpoint): RuntimeCheckpoint {
  return JSON.parse(JSON.stringify(value)) as RuntimeCheckpoint;
}

function assertRunId(runId: string): string {
  if (typeof runId !== "string" || runId.length === 0) throw new Error("agent_run_id_required");
  return runId;
}

export { CHECKPOINT_VERSION };
