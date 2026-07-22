import { z } from "zod";
import { DecisionStatusSchema, EvidenceSchema, JsonValueSchema, ProfileFactSchema } from "./profile.js";

export const RagFieldTypeSchema = z.enum(["text", "textarea", "select", "boolean", "date"]);
export const RagFieldRequestSchema = z.object({
  taskId: z.string().min(1).max(128),
  fieldId: z.string().min(1).max(128),
  semantic: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
  type: RagFieldTypeSchema,
  options: z.array(z.string().min(1).max(500)).max(100).optional(),
  validators: z.array(z.string().min(1).max(500)).max(50).optional(),
  jobDescription: z.string().min(1).max(30_000).optional()
}).strict();

export const RagRetrievalPlanSchema = z.object({
  semantic: z.string(),
  requestType: RagFieldTypeSchema,
  requiredSources: z.array(z.enum(["application", "profile"])),
  requiredRange: z.object({ min: z.string().optional(), max: z.string().optional() }).strict().optional(),
  needsJobDescription: z.boolean(),
  autoFillEligible: z.boolean(),
  risk: z.enum(["none", "sensitive_commitment", "unknown_semantic"]),
  validators: z.array(z.string()),
  strategy: z.array(z.enum(["exact", "keyword", "embedding"])),
  valid: z.boolean(),
  invalidReason: z.string().optional()
}).strict();

export const RagFieldDecisionSchema = z.object({
  fieldId: z.string(),
  status: DecisionStatusSchema,
  value: JsonValueSchema.optional(),
  evidence: z.array(EvidenceSchema),
  confidence: z.number().min(0).max(1),
  question: z.string().optional(),
  validators: z.array(z.string())
}).strict();

export const RagFieldInspectionSchema = z.object({
  request: RagFieldRequestSchema,
  plan: RagRetrievalPlanSchema,
  decision: RagFieldDecisionSchema
}).strict();

export const RagFieldAnswerBodySchema = RagFieldRequestSchema.extend({
  value: JsonValueSchema,
  promoteToProfile: z.boolean().optional(),
  profileFactId: z.string().min(1).max(128).optional()
}).strict();

export const RagFieldCorrectionResponseSchema = z.object({
  correction: ProfileFactSchema,
  inspection: RagFieldInspectionSchema
}).strict();

export type RagFieldRequest = z.infer<typeof RagFieldRequestSchema>;
export type RagFieldAnswerBody = z.infer<typeof RagFieldAnswerBodySchema>;
export type RagFieldInspection = z.infer<typeof RagFieldInspectionSchema>;
export type RagFieldCorrectionResponse = z.infer<typeof RagFieldCorrectionResponseSchema>;
