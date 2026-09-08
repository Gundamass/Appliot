import { z } from "zod";
import { JsonValueSchema } from "./profile.js";
import { EvidenceRefSchema } from "./agent-runtime.js";

export const PrimaryGoalSchema = z.enum([
  "analyze_resume",
  "analyze_job",
  "match_resume_to_job",
  "prepare_application",
  "fill_application",
  "submit_application",
  "track_application",
  "update_resume_profile"
]);

export type PrimaryGoal = z.infer<typeof PrimaryGoalSchema>;

export const SubGoalSchema = z.enum([
  "select_latest_resume",
  "select_resume",
  "analyze_resume",
  "identify_target_job",
  "analyze_job",
  "match_resume_to_job",
  "prepare_application",
  "fill_application",
  "verify_application",
  "request_human_approval",
  "submit_application",
  "review_result",
  "track_application",
  "update_resume_profile"
]);

export type SubGoal = z.infer<typeof SubGoalSchema>;

export const IntentValueSourceSchema = z.enum([
  "user_explicit",
  "user_clarified",
  "verified_memory",
  "document_evidence",
  "environment_observation",
  "model_inference"
]);

export type IntentValueSource = z.infer<typeof IntentValueSourceSchema>;

export const IntentFieldSchema = z.object({
  value: JsonValueSchema,
  source: IntentValueSourceSchema,
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string().min(1).max(128)).max(100),
  requiresConfirmation: z.boolean()
}).strict();

export type IntentField = z.infer<typeof IntentFieldSchema>;

const IntentFieldMapSchema = z.record(z.string().min(1).max(128), IntentFieldSchema).superRefine((fields, context) => {
  if (Object.keys(fields).length > 50) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "too_many_intent_fields" });
  }
});

export const IntentEntitiesSchema = IntentFieldMapSchema;
export type IntentEntities = z.infer<typeof IntentEntitiesSchema>;

export const IntentConstraintSchema = z.object({
  type: z.string().min(1).max(128),
  value: JsonValueSchema,
  source: IntentValueSourceSchema,
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string().min(1).max(128)).max(100),
  requiresConfirmation: z.boolean().optional()
}).strict();

export type IntentConstraint = z.infer<typeof IntentConstraintSchema>;

export const IntentPreferenceSchema = z.object({
  type: z.string().min(1).max(128),
  value: JsonValueSchema,
  source: IntentValueSourceSchema,
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string().min(1).max(128)).max(100)
}).strict();

export type IntentPreference = z.infer<typeof IntentPreferenceSchema>;

export const SuccessCriterionSchema = z.object({
  id: z.string().min(1).max(128),
  description: z.string().min(1).max(1_000),
  required: z.boolean()
}).strict();

export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;

export const RiskProfileSchema = z.object({
  level: z.enum(["low", "medium", "high", "irreversible"]),
  requiresHumanApproval: z.boolean(),
  reasons: z.array(z.string().min(1).max(500)).max(20),
  sensitiveFields: z.array(z.string().min(1).max(128)).max(50).optional()
}).strict();

export type RiskProfile = z.infer<typeof RiskProfileSchema>;

export const IntentAmbiguitySchema = z.object({
  id: z.string().min(1).max(128),
  field: z.string().min(1).max(128),
  reason: z.string().min(1).max(1_000),
  severity: z.enum(["low", "medium", "high"]),
  candidateValues: z.array(JsonValueSchema).max(20).optional()
}).strict();

export type IntentAmbiguity = z.infer<typeof IntentAmbiguitySchema>;

export const MissingInformationSchema = z.object({
  field: z.string().min(1).max(128),
  reason: z.string().min(1).max(1_000),
  blocking: z.boolean(),
  priority: z.number().int().positive().max(100)
}).strict();

export type MissingInformation = z.infer<typeof MissingInformationSchema>;

export const IntentConflictSchema = z.object({
  field: z.string().min(1).max(128),
  values: z.array(z.object({
    value: JsonValueSchema,
    source: IntentValueSourceSchema,
    evidenceRefs: z.array(z.string().min(1).max(128)).max(100)
  }).strict()).min(2).max(10),
  resolution: z.enum(["prefer_user", "request_clarification", "defer_to_review"])
}).strict();

export type IntentConflict = z.infer<typeof IntentConflictSchema>;

const CanonicalIntentBaseSchema = z.object({
  intentId: z.string().min(1).max(128),
  schemaVersion: z.string().min(1).max(32),
  revision: z.number().int().positive(),
  rawInputRef: z.string().min(1).max(256),
  primaryGoal: PrimaryGoalSchema,
  subGoals: z.array(SubGoalSchema).max(32),
  entities: IntentEntitiesSchema,
  constraints: z.array(IntentConstraintSchema).max(100),
  preferences: z.array(IntentPreferenceSchema).max(100),
  successCriteria: z.array(SuccessCriterionSchema).max(50),
  riskProfile: RiskProfileSchema,
  confidence: z.number().min(0).max(1),
  ambiguities: z.array(IntentAmbiguitySchema).max(50),
  missingInformation: z.array(MissingInformationSchema).max(50),
  conflicts: z.array(IntentConflictSchema).max(50).optional(),
  autonomyLevel: z.enum(["suggest", "prepare", "execute_with_approval"]),
  evidenceRefs: z.array(EvidenceRefSchema).max(500),
  createdAt: z.string().datetime()
}).strict();

export const CanonicalIntentSchema = CanonicalIntentBaseSchema.superRefine((intent, context) => {
  Object.entries(intent.entities).forEach(([field, value]) => {
    if (value.source === "model_inference" && !value.requiresConfirmation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `model_inference_requires_confirmation:${field}`,
        path: ["entities", field, "requiresConfirmation"]
      });
    }
  });
  if (intent.riskProfile.requiresHumanApproval && intent.autonomyLevel === "suggest") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "approval_required_for_risky_intent" });
  }
});

export type CanonicalIntent = z.infer<typeof CanonicalIntentSchema>;

export const ClarificationOptionSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(500),
  value: JsonValueSchema.optional()
}).strict();

export type ClarificationOption = z.infer<typeof ClarificationOptionSchema>;

export const ClarificationRequestSchema = z.object({
  questionId: z.string().min(1).max(128),
  question: z.string().min(1).max(2_000),
  options: z.array(ClarificationOptionSchema).max(20).optional(),
  blocking: z.boolean(),
  relatedFields: z.array(z.string().min(1).max(128)).min(1).max(20),
  expiresAt: z.string().datetime().optional()
}).strict();

export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;

export const IntentDraftSchema = CanonicalIntentBaseSchema.partial();

export const IntentResolutionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resolved"), intent: CanonicalIntentSchema }).strict(),
  z.object({
    type: z.literal("needs_clarification"),
    intent: IntentDraftSchema,
    question: ClarificationRequestSchema
  }).strict(),
  z.object({ type: z.literal("rejected"), reason: z.string().min(1).max(2_000) }).strict()
]);

export type IntentResolution = z.infer<typeof IntentResolutionSchema>;
