import { createHash } from "node:crypto";
import { z } from "zod";
import { AuditTraceInputSchema, SkillTraceDimensionsSchema, type AuditTraceInput } from "@resume/contracts";
import type { SqliteDatabase } from "../db/client.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const LangSmithReviewEventSchema = z.object({
  runIdHash: HashSchema,
  parentRunIdHash: HashSchema.optional(),
  graphVersion: z.string().min(1).max(40),
  nodeName: z.string().min(1).max(80),
  nodeVersion: z.string().min(1).max(40),
  eventType: z.string().min(1).max(40),
  toolName: z.string().min(1).max(80).optional(),
  outcome: z.string().min(1).max(80),
  reasonCode: z.string().min(1).max(80),
  confidence: z.number().min(0).max(1).optional(),
  candidateCount: z.number().int().nonnegative().max(100),
  evidenceCount: z.number().int().nonnegative().max(100),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  errorCode: z.string().min(1).max(80).optional(),
  skill: SkillTraceDimensionsSchema.optional(),
  createdAt: z.string().datetime()
}).strict();

export type LangSmithReviewEvent = z.infer<typeof LangSmithReviewEventSchema>;

const ProjectionInputSchema = AuditTraceInputSchema.extend({
  parentRunId: z.string().min(1).max(256).optional(),
  graphVersion: z.string().min(1).max(40).optional(),
  nodeVersion: z.string().min(1).max(40).optional(),
  summary: z.string().max(2_000).optional(),
  prompt: z.string().max(20_000).optional(),
  dom: z.string().max(20_000).optional(),
  evidenceQuote: z.string().max(20_000).optional()
}).strict();

export interface LangSmithOutboxItem {
  id: string;
  traceId: string;
  event: LangSmithReviewEvent;
  status: "pending" | "processing" | "sent" | "dead_letter";
  attempts: number;
  nextAttemptAt: string;
  remoteRunId?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LangSmithOutbox {
  enqueue(traceId: string, event: LangSmithReviewEvent): void;
  claim(limit?: number, now?: Date): LangSmithOutboxItem[];
  markSent(id: string, remoteRunId: string): void;
  markFailed(id: string, errorCode: string, now?: Date): { status: "pending" | "dead_letter"; attempts: number };
  list(): LangSmithOutboxItem[];
  deleteUnsent(traceIds?: readonly string[]): number;
}

export interface SqliteLangSmithOutboxOptions {
  maxAttempts?: number;
  now?: () => Date;
}

interface OutboxRow {
  id: string;
  trace_id: string;
  payload_json: string;
  status: LangSmithOutboxItem["status"];
  attempts: number;
  next_attempt_at: string;
  remote_run_id: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

export function projectLangSmithEvent(input: unknown, createdAt = new Date().toISOString()): LangSmithReviewEvent {
  const parsed = ProjectionInputSchema.parse(input);
  rejectSensitiveProjectionValues(parsed);
  const candidateCount = parsed.candidateIds?.length ?? parsed.counts?.candidates ?? 0;
  const evidenceCount = parsed.evidenceIds?.length ?? parsed.counts?.evidence ?? 0;
  const base = {
    runIdHash: hashIdentity(parsed.runId),
    graphVersion: parsed.graphVersion ?? "agent-v1",
    nodeName: parsed.node,
    nodeVersion: parsed.nodeVersion ?? "v1",
    eventType: parsed.kind,
    outcome: parsed.outcome,
    reasonCode: parsed.reasonCode,
    candidateCount,
    evidenceCount,
    createdAt
  };
  return LangSmithReviewEventSchema.parse({
    ...base,
    ...(parsed.parentRunId === undefined ? {} : { parentRunIdHash: hashIdentity(parsed.parentRunId) }),
    ...(parsed.toolName === undefined ? {} : { toolName: parsed.toolName }),
    ...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }),
    ...(parsed.durationMs === undefined ? {} : { durationMs: parsed.durationMs }),
    ...(parsed.errorCode === undefined ? {} : { errorCode: parsed.errorCode }),
    ...(parsed.skill === undefined ? {} : { skill: parsed.skill })
  });
}

export function createSqliteLangSmithOutbox(
  database: SqliteDatabase,
  options: SqliteLangSmithOutboxOptions = {}
): LangSmithOutbox {
  const maxAttempts = options.maxAttempts ?? 3;
  const now = options.now ?? (() => new Date());
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("langsmith_max_attempts_invalid");
  }

  const insert = database.prepare(`
    INSERT INTO langsmith_trace_outbox (
      id, trace_id, run_id_hash, payload_json, status, attempts, next_attempt_at,
      remote_run_id, last_error_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)
    ON CONFLICT(trace_id) DO NOTHING
  `);
  const selectReady = database.prepare(`
    SELECT * FROM langsmith_trace_outbox
    WHERE status = 'pending' AND next_attempt_at <= ?
    ORDER BY created_at ASC, id ASC LIMIT ?
  `);
  const markProcessing = database.prepare(
    "UPDATE langsmith_trace_outbox SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'"
  );
  const markSentStatement = database.prepare(`
    UPDATE langsmith_trace_outbox
    SET status = 'sent', remote_run_id = ?, updated_at = ?, last_error_code = NULL
    WHERE id = ? AND status = 'processing'
  `);
  const markFailedStatement = database.prepare(`
    UPDATE langsmith_trace_outbox
    SET status = ?, attempts = ?, next_attempt_at = ?, last_error_code = ?, updated_at = ?
    WHERE id = ? AND status = 'processing'
  `);
  const selectAll = database.prepare("SELECT * FROM langsmith_trace_outbox ORDER BY created_at ASC, id ASC");
  const deleteUnsentStatement = database.prepare(
    "DELETE FROM langsmith_trace_outbox WHERE status IN ('pending', 'processing') AND trace_id = ?"
  );

  return {
    enqueue(traceId, event) {
      const parsed = LangSmithReviewEventSchema.parse(event);
      const timestamp = now().toISOString();
      insert.run(
        outboxId(traceId),
        traceId,
        parsed.runIdHash,
        JSON.stringify(parsed),
        timestamp,
        timestamp,
        timestamp
      );
    },
    claim(limit = 20, at = now()) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("langsmith_batch_invalid");
      return database.transaction(() => {
        const timestamp = at.toISOString();
        const rows = selectReady.all(timestamp, limit) as OutboxRow[];
        const claimed: LangSmithOutboxItem[] = [];
        for (const row of rows) {
          if (markProcessing.run(timestamp, row.id).changes !== 1) continue;
          claimed.push(fromRow({ ...row, status: "processing", updated_at: timestamp }));
        }
        return claimed;
      })();
    },
    markSent(id, remoteRunId) {
      if (remoteRunId.length === 0 || remoteRunId.length > 256) throw new Error("langsmith_remote_id_invalid");
      markSentStatement.run(remoteRunId, now().toISOString(), id);
    },
    markFailed(id, errorCode, at = now()) {
      const row = database.prepare("SELECT attempts FROM langsmith_trace_outbox WHERE id = ?").get(id) as { attempts: number } | undefined;
      if (row === undefined) throw new Error("langsmith_outbox_item_missing");
      const attempts = row.attempts + 1;
      const status = attempts >= maxAttempts ? "dead_letter" : "pending";
      const delayMs = status === "dead_letter" ? 0 : Math.min(60_000, 1_000 * (2 ** (attempts - 1)));
      const nextAttemptAt = new Date(at.getTime() + delayMs).toISOString();
      markFailedStatement.run(status, attempts, nextAttemptAt, normalizeErrorCode(errorCode), at.toISOString(), id);
      return { status, attempts };
    },
    list() {
      return (selectAll.all() as OutboxRow[]).map(fromRow);
    },
    deleteUnsent(traceIds) {
      if (traceIds === undefined) {
        return database.prepare("DELETE FROM langsmith_trace_outbox WHERE status IN ('pending', 'processing')").run().changes;
      }
      return database.transaction(() => traceIds.reduce((count, traceId) => count + deleteUnsentStatement.run(traceId).changes, 0))();
    }
  };
}

export function hashIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function outboxId(traceId: string): string {
  return `outbox_${hashIdentity(traceId)}`;
}

function fromRow(row: OutboxRow): LangSmithOutboxItem {
  const event = LangSmithReviewEventSchema.parse(JSON.parse(row.payload_json));
  return {
    id: row.id,
    traceId: row.trace_id,
    event,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(row.remote_run_id === null ? {} : { remoteRunId: row.remote_run_id }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeErrorCode(value: string): string {
  const code = value.toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 80);
  return code || "remote_error";
}

function rejectSensitiveProjectionValues(input: z.infer<typeof ProjectionInputSchema>): void {
  const sensitiveFields = [input.summary, input.prompt, input.dom, input.evidenceQuote].filter(
    (value): value is string => value !== undefined
  );
  const allStrings = [
    input.runId, input.taskId, input.node, input.outcome, input.reasonCode,
    input.parentRunId, input.graphVersion, input.nodeVersion, input.toolName,
    input.errorCode, ...sensitiveFields
  ].filter((value): value is string => value !== undefined);
  const hasSensitivePattern = allStrings.some((value) =>
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)
    || /(?:^|\D)(?:\+?86[- ]?)?1[3-9]\d{9}(?:$|\D)/.test(value)
    || /<\/?[a-z][^>]*>/i.test(value)
    || /https?:\/\/[^\s?#]+[^\s#]*\?[^\s#]+/iu.test(value)
    || /(?:approval|access|refresh|secret|auth|bearer|session|credential|private)[_.:-]?(?:token|key|secret)/iu.test(value)
    || /^sk-(?:proj-)?[A-Za-z0-9_-]{6,}$/u.test(value)
    || /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}$/u.test(value)
  );
  const hasChineseNameSummary = sensitiveFields.some((value) => /^[\u4e00-\u9fff]{2,4}$/.test(value.trim()));
  if (hasSensitivePattern || hasChineseNameSummary || input.prompt !== undefined || input.dom !== undefined || input.evidenceQuote !== undefined) {
    throw new Error("trace_pii_rejected");
  }
}
