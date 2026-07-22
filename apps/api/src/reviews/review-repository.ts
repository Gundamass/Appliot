import { SelfEvaluationDraftSchema, type SelfEvaluationDraft } from "@resume/contracts";
import type { SqliteDatabase } from "../db/client.js";

interface ReviewRow { task_id: string; payload_json: string; status: "needs_review" | "approved" | "blocked" | "promoted"; }

export interface SelfEvaluationReviewRepository {
  get(taskId: string): SelfEvaluationDraft | undefined;
  save(draft: SelfEvaluationDraft): SelfEvaluationDraft;
  approve(taskId: string): SelfEvaluationDraft;
  markPromoted(taskId: string): SelfEvaluationDraft;
  isPromoted(taskId: string): boolean;
}

export function createSelfEvaluationReviewRepository(database: SqliteDatabase): SelfEvaluationReviewRepository {
  const find = database.prepare("SELECT task_id, payload_json, status FROM self_evaluation_reviews WHERE task_id = ?");
  const save = database.prepare(`INSERT INTO self_evaluation_reviews (task_id, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET payload_json = excluded.payload_json, status = excluded.status, updated_at = excluded.updated_at`);
  const updateStatus = database.prepare("UPDATE self_evaluation_reviews SET payload_json = ?, status = ?, updated_at = ? WHERE task_id = ?");
  const parse = (row: ReviewRow | undefined): SelfEvaluationDraft | undefined => row ? SelfEvaluationDraftSchema.parse({ ...JSON.parse(row.payload_json), status: row.status === "promoted" ? "approved" : row.status }) : undefined;
  const timestamp = () => new Date().toISOString();
  return {
    get(taskId) { return parse(find.get(taskId) as ReviewRow | undefined); },
    save(draft) { const parsed = SelfEvaluationDraftSchema.parse(draft); const now = timestamp(); save.run(parsed.taskId, JSON.stringify(parsed), parsed.status, now, now); return parsed; },
    approve(taskId) { const current = parse(find.get(taskId) as ReviewRow | undefined); if (!current || current.status !== "needs_review") throw new Error("review is not awaiting approval"); const approved = SelfEvaluationDraftSchema.parse({ ...current, status: "approved" }); updateStatus.run(JSON.stringify(approved), "approved", timestamp(), taskId); return approved; },
    markPromoted(taskId) { const current = parse(find.get(taskId) as ReviewRow | undefined); if (!current || current.status !== "approved") throw new Error("review is not approved"); updateStatus.run(JSON.stringify(current), "promoted", timestamp(), taskId); return current; },
    isPromoted(taskId) { return (find.get(taskId) as ReviewRow | undefined)?.status === "promoted"; }
  };
}
