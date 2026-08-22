import {
  ApplicationContentReviewSchema,
  type ApplicationContentReview
} from "@resume/contracts";
import { z } from "zod";
import type { SqliteDatabase } from "../db/client.js";

const ReviewMetadataSchema = z.object({
  taskId: z.string().min(1),
  interruptId: z.string().min(1)
}).passthrough();

export interface GraphApplicationReview extends ApplicationContentReview {
  taskId: string;
  interruptId: string;
}

export interface GraphApplicationReviewRepository {
  save(review: GraphApplicationReview): GraphApplicationReview;
  current(taskId: string): GraphApplicationReview | undefined;
  find(taskId: string, reviewId: string): GraphApplicationReview | undefined;
  approve(taskId: string, reviewId: string, draft?: string): GraphApplicationReview | undefined;
  approvedValue(taskId: string, fieldId: string): string | undefined;
  remove(taskId: string, reviewId: string): void;
}

interface ReviewRow {
  id: string;
  task_id: string;
  interrupt_id: string;
  field_id: string;
  field_label: string;
  original: string;
  draft: string;
  reasons_json: string;
  evidence_json: string;
  unsupported_claims_json: string;
  status: ApplicationContentReview["status"];
}

export function createGraphApplicationReviewRepository(
  database: SqliteDatabase
): GraphApplicationReviewRepository {
  const upsert = database.prepare(`
    INSERT INTO agent_application_reviews (
      id, task_id, interrupt_id, field_id, field_label, original, draft,
      reasons_json, evidence_json, unsupported_claims_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, interrupt_id) DO UPDATE SET
      id = excluded.id,
      field_id = excluded.field_id,
      field_label = excluded.field_label,
      original = excluded.original,
      draft = excluded.draft,
      reasons_json = excluded.reasons_json,
      evidence_json = excluded.evidence_json,
      unsupported_claims_json = excluded.unsupported_claims_json,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);
  const findById = database.prepare(`
    SELECT * FROM agent_application_reviews WHERE task_id = ? AND id = ?
  `);
  const findCurrent = database.prepare(`
    SELECT * FROM agent_application_reviews
    WHERE task_id = ? AND status IN ('needs_review', 'blocked')
    ORDER BY updated_at DESC LIMIT 1
  `);
  const findApprovedValue = database.prepare(`
    SELECT draft FROM agent_application_reviews
    WHERE task_id = ? AND field_id = ? AND status = 'approved'
    ORDER BY updated_at DESC LIMIT 1
  `);
  const updateApproved = database.prepare(`
    UPDATE agent_application_reviews
    SET draft = ?, status = 'approved', updated_at = ?
    WHERE task_id = ? AND id = ? AND status = 'needs_review'
  `);
  const remove = database.prepare(`
    DELETE FROM agent_application_reviews WHERE task_id = ? AND id = ?
  `);

  return {
    save(input) {
      const review = parseReview(input);
      const now = new Date().toISOString();
      upsert.run(
        review.id,
        review.taskId,
        review.interruptId,
        review.fieldId,
        review.fieldLabel,
        review.original,
        review.draft,
        JSON.stringify(review.reasons),
        JSON.stringify(review.evidence),
        JSON.stringify(review.unsupportedClaims),
        review.status,
        now,
        now
      );
      return review;
    },

    current(taskId) {
      return fromRow(findCurrent.get(taskId) as ReviewRow | undefined);
    },

    find(taskId, reviewId) {
      return fromRow(findById.get(taskId, reviewId) as ReviewRow | undefined);
    },

    approve(taskId, reviewId, draft) {
      const existing = fromRow(findById.get(taskId, reviewId) as ReviewRow | undefined);
      if (existing === undefined || existing.status !== "needs_review") return undefined;
      const approved = parseReview({ ...existing, draft: draft ?? existing.draft, status: "approved" });
      updateApproved.run(approved.draft, new Date().toISOString(), taskId, reviewId);
      return approved;
    },

    approvedValue(taskId, fieldId) {
      const row = findApprovedValue.get(taskId, fieldId) as { draft: string } | undefined;
      return row?.draft;
    },

    remove(taskId, reviewId) {
      remove.run(taskId, reviewId);
    }
  };
}

function parseReview(input: GraphApplicationReview): GraphApplicationReview {
  const metadata = ReviewMetadataSchema.parse(input);
  const { taskId, interruptId, ...content } = metadata;
  return { ...ApplicationContentReviewSchema.parse(content), taskId, interruptId };
}

function fromRow(row: ReviewRow | undefined): GraphApplicationReview | undefined {
  if (row === undefined) return undefined;
  return parseReview({
    id: row.id,
    taskId: row.task_id,
    interruptId: row.interrupt_id,
    fieldId: row.field_id,
    fieldLabel: row.field_label,
    original: row.original,
    draft: row.draft,
    reasons: JSON.parse(row.reasons_json) as string[],
    evidence: JSON.parse(row.evidence_json),
    unsupportedClaims: JSON.parse(row.unsupported_claims_json) as string[],
    status: row.status
  });
}
