import { z } from "zod";
import { EvidenceSchema } from "./profile.js";

export const SelfEvaluationReviewStatusSchema = z.enum(["needs_review", "approved", "blocked"]);
export const SelfEvaluationDraftSchema = z.object({
  taskId: z.string().min(1).max(128),
  original: z.string().min(1).max(12_000),
  draft: z.string().min(1).max(12_000),
  reasons: z.array(z.string().min(1).max(1_000)).min(1).max(12),
  evidence: z.array(EvidenceSchema).max(50),
  unsupportedClaims: z.array(z.string().min(1).max(500)).max(50),
  status: SelfEvaluationReviewStatusSchema
}).strict();

export type SelfEvaluationDraft = z.infer<typeof SelfEvaluationDraftSchema>;
export type SelfEvaluationReviewStatus = z.infer<typeof SelfEvaluationReviewStatusSchema>;
