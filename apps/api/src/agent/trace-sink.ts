import { createHash } from "node:crypto";
import { AuditTraceInputSchema, type AuditTraceInput } from "@resume/contracts";
import type { SqliteDatabase } from "../db/client.js";
import { projectLangSmithEvent } from "./langsmith-outbox.js";

export interface StoredTraceEvent extends AuditTraceInput {
  id: string;
  sequence: number;
  createdAt: string;
}

export interface TraceSink {
  record(input: AuditTraceInput): string;
  list(runId: string): StoredTraceEvent[];
}

export interface TraceSinkOptions {
  langSmithEnabled?: boolean;
}

interface TraceRow {
  id: string;
  sequence: number;
  payload_json: string;
  created_at: string;
}

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const phonePattern = /(?:^|\D)(?:\+?86[- ]?)?1[3-9]\d{9}(?:$|\D)/;
const markupPattern = /<\/?[a-z][^>]*>/i;

export function createSqliteTraceSink(database: SqliteDatabase, options: TraceSinkOptions = {}): TraceSink {
  const insert = database.prepare(`
    INSERT INTO agent_trace_events (
      id, run_id, task_id, sequence, node, kind, outcome, reason_code, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const nextSequence = database.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
    FROM agent_trace_events WHERE run_id = ?
  `);
  const listRows = database.prepare(`
    SELECT id, sequence, payload_json, created_at
    FROM agent_trace_events WHERE run_id = ? ORDER BY sequence ASC
  `);
  const insertOutbox = options.langSmithEnabled === true
    ? database.prepare(`
      INSERT INTO langsmith_trace_outbox (
        id, trace_id, run_id_hash, payload_json, status, attempts, next_attempt_at,
        remote_run_id, last_error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)
      ON CONFLICT(trace_id) DO NOTHING
    `)
    : undefined;

  const write = database.transaction((input: AuditTraceInput) => {
    const sequence = (nextSequence.get(input.runId) as { sequence: number }).sequence;
    const id = traceId(input.runId, sequence);
    const createdAt = new Date().toISOString();
    insert.run(
      id,
      input.runId,
      input.taskId,
      sequence,
      input.node,
      input.kind,
      input.outcome,
      input.reasonCode,
      JSON.stringify(input),
      createdAt
    );
    if (insertOutbox !== undefined) {
      const event = projectLangSmithEvent(input, createdAt);
      insertOutbox.run(
        `outbox_${createHash("sha256").update(id).digest("hex")}`,
        id,
        event.runIdHash,
        JSON.stringify(event),
        createdAt,
        createdAt,
        createdAt
      );
    }
    return id;
  });

  return {
    record(input) {
      const parsed = AuditTraceInputSchema.parse(input);
      assertTraceSafe(parsed);
      return write(parsed);
    },
    list(runId) {
      return (listRows.all(runId) as TraceRow[]).map((row) => ({
        ...AuditTraceInputSchema.parse(JSON.parse(row.payload_json)),
        id: row.id,
        sequence: row.sequence,
        createdAt: row.created_at
      }));
    }
  };
}

export function traceId(runId: string, sequence: number): string {
  return `trace_${createHash("sha256").update(`${runId}${sequence}`).digest("hex")}`;
}

function assertTraceSafe(input: AuditTraceInput): void {
  const values = [input.runId, input.taskId, input.node, input.outcome, input.reasonCode];
  if (values.some((value) => emailPattern.test(value) || phonePattern.test(value) || markupPattern.test(value))) {
    throw new Error("trace_pii_rejected");
  }
}
