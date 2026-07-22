import { SelfEvaluationReviewSchema, type SelfEvaluationReview } from "@resume/contracts";
import type { SqliteDatabase } from "../db/client.js";

type StoredStatus = "needs_review" | "approved" | "blocked" | "promoted";
interface ReviewRow { task_id: string; payload_json: string; status: StoredStatus; }

export interface SelfEvaluationReviewRepository {
  get(taskId: string): SelfEvaluationReview | undefined;
  save(review: SelfEvaluationReview): SelfEvaluationReview;
  approve(taskId: string): SelfEvaluationReview;
  markPromoted(taskId: string): SelfEvaluationReview;
}

export function createSelfEvaluationReviewRepository(database: SqliteDatabase): SelfEvaluationReviewRepository {
  const find = database.prepare("SELECT task_id, payload_json, status FROM self_evaluation_reviews WHERE task_id = ?");
  const save = database.prepare(`INSERT INTO self_evaluation_reviews (task_id, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET payload_json = excluded.payload_json, status = excluded.status, updated_at = excluded.updated_at WHERE self_evaluation_reviews.status = 'needs_review'`);
  const update = database.prepare("UPDATE self_evaluation_reviews SET payload_json = ?, status = ?, updated_at = ? WHERE task_id = ? AND status = ?");
  const now = () => new Date().toISOString();
  const parse = (row: ReviewRow | undefined): SelfEvaluationReview | undefined => row
    ? SelfEvaluationReviewSchema.parse({ ...JSON.parse(row.payload_json), status: row.status === "promoted" ? "approved" : row.status })
    : undefined;
  const transition = (taskId: string, from: StoredStatus, to: StoredStatus): SelfEvaluationReview => {
    const current = parse(find.get(taskId) as ReviewRow | undefined);
    if (!current || (from === "promoted" ? false : current.status !== from)) throw new Error("review transition conflict");
    const next = SelfEvaluationReviewSchema.parse({ ...current, status: to === "promoted" ? "approved" : to });
    if (update.run(JSON.stringify(next), to, now(), taskId, from).changes !== 1) throw new Error("review transition conflict");
    return next;
  };
  return {
    get(taskId) { return parse(find.get(taskId) as ReviewRow | undefined); },
    save(review) {
      const parsed = SelfEvaluationReviewSchema.parse(review);
      const time = now();
      const result = save.run(parsed.taskId, JSON.stringify(parsed), parsed.status, time, time);
      if (result.changes !== 1) throw new Error("review transition conflict");
      return parsed;
    },
    approve(taskId) { return transition(taskId, "needs_review", "approved"); },
    markPromoted(taskId) { return transition(taskId, "approved", "promoted"); }
  };
}
