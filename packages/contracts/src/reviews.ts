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

export const SelfEvaluationClaimSchema = z.object({
  text: z.string().min(1).max(500),
  kind: z.enum(["emphasis", "evidence"]),
  evidenceFactIds: z.array(z.string().min(1).max(128)).min(1).max(12)
}).strict();

export const SelfEvaluationGeneratedDraftSchema = z.object({
  draft: z.string().min(1).max(12_000),
  reasons: z.array(z.string().min(1).max(1_000)).min(1).max(12),
  claims: z.array(SelfEvaluationClaimSchema).max(50)
}).strict();

export const SelfEvaluationBaseSchema = z.object({
  factId: z.string().min(1).max(128),
  revision: z.number().int().positive(),
  original: z.string().min(1).max(12_000),
  evidence: z.array(EvidenceSchema).min(1).max(50)
}).strict();

export const SelfEvaluationReviewSchema = SelfEvaluationDraftSchema.extend({
  base: SelfEvaluationBaseSchema
}).strict();

export const CreateSelfEvaluationReviewBodySchema = z.object({
  jobDescription: z.string().min(1).max(30_000),
  draft: SelfEvaluationGeneratedDraftSchema
}).strict();

export const ApproveSelfEvaluationReviewBodySchema = z.object({
  editedDraft: z.string().min(1).max(12_000).optional(),
  keepOriginal: z.literal(true).optional()
}).strict().superRefine((value, context) => {
  if (value.editedDraft !== undefined && value.keepOriginal === true) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "choose one approval action" });
  }
});

export const PromoteSelfEvaluationReviewBodySchema = z.union([z.undefined(), z.object({}).strict()]);

export type SelfEvaluationDraft = z.infer<typeof SelfEvaluationDraftSchema>;
export type SelfEvaluationReviewStatus = z.infer<typeof SelfEvaluationReviewStatusSchema>;
export type SelfEvaluationGeneratedDraft = z.infer<typeof SelfEvaluationGeneratedDraftSchema>;
export type SelfEvaluationReview = z.infer<typeof SelfEvaluationReviewSchema>;
