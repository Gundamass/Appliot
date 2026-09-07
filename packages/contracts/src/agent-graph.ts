import { z } from "zod";
import { SkillBindingSchema } from "./application-skill.js";

export const GraphStatusSchema = z.enum(["running", "interrupted", "completed", "failed", "cancelled"]);
export const SubgraphNameSchema = z.enum(["resume_ingestion", "job_matching", "application"]);
export const HumanInterruptSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["missing_fact", "fact_conflict", "field_semantics", "content_review", "login", "challenge", "final_review"]),
  reasonCode: z.string().min(1).max(80),
  questionIds: z.array(z.string().min(1)).max(50),
  evidenceIds: z.array(z.string().min(1)).max(100),
  createdAt: z.string().datetime()
}).strict();
export const HumanResumeSchema = z.object({
  interruptId: z.string().min(1),
  action: z.enum(["confirm", "correct", "approve", "reject", "cancel"]),
  values: z.record(z.unknown())
}).strict();
export const GraphErrorSchema = z.object({
  code: z.string().min(1).max(80), retryable: z.boolean(), node: z.string().min(1), detailHash: z.string().optional()
}).strict();
export const ResumeIngestionStateSchema = z.object({
  documentId: z.string().optional(), documentFingerprint: z.string().length(64).optional(),
  pageSources: z.array(z.enum(["pdf", "ocr"])).optional(), candidateFactIds: z.array(z.string()).optional(),
  acceptedFactIds: z.array(z.string()).optional(), publishedProfileRevision: z.number().int().positive().optional()
}).strict();
export const JobRequirementAdvisoryStateSchema = z.object({
  outcome: z.enum(["satisfied", "unknown"]),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string().min(1)).max(3)
}).strict();
export const JobMatchingStateSchema = z.object({
  sessionId: z.string(), postingIds: z.array(z.string()).optional(),
  recommendedResultIds: z.array(z.string()).optional(), conflictResultIds: z.array(z.string()).optional(),
  adapterVersion: z.string().optional(), scoringVersion: z.literal("job-match-v1").optional(),
  retrievalProvider: z.enum(["lightrag", "deterministic_fallback"]).optional(),
  retrievalVersion: z.string().optional(), retrievalHealthy: z.boolean().optional(),
  fallbackUsed: z.boolean().optional(), embeddingHealthy: z.boolean().optional(),
  advisories: z.array(z.object({
    postingId: z.string().min(1), requirementId: z.string().min(1), advisory: JobRequirementAdvisoryStateSchema
  }).strict()).max(100).optional()
}).strict();
const SensitiveTraceTokenPattern = /(?:approval|access|refresh|secret|auth|bearer|session|credential|private)[_.:-]?(?:token|key|secret)/iu;
const ApiKeyTracePattern = /^sk-(?:proj-)?[A-Za-z0-9_-]{6,}$/u;
const JwtTracePattern = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}$/u;
const isSafeTraceIdentifier = (value: string) => (
  !SensitiveTraceTokenPattern.test(value)
  && !ApiKeyTracePattern.test(value)
  && !JwtTracePattern.test(value)
);
const TraceIdentifierSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u)
  .refine(isSafeTraceIdentifier, "sensitive_trace_token");
const TraceCodeSchema = TraceIdentifierSchema.refine((value) => value.length <= 80);
const SkillTraceIdentifierSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u)
  .refine(isSafeTraceIdentifier, "sensitive_trace_token");
export const SkillTraceDimensionsSchema = z.object({
  skillId: SkillTraceIdentifierSchema,
  skillVersion: z.string().max(64).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u),
  pageFingerprintHash: z.string().regex(/^[a-f0-9]{64}$/u),
  pageVariantId: SkillTraceIdentifierSchema,
  allocation: z.enum(["champion", "challenger"])
}).strict();
export const ApplicationExecutionStateSchema = z.object({
  applicationUrl: z.string().url(), snapshotId: z.string().optional(), executionEpoch: z.number().int().nonnegative(),
  fieldIds: z.array(z.string()).optional(), plannedCommandIds: z.array(z.string()).optional(),
  completedCommandIds: z.array(z.string()).optional(), retryCount: z.number().int().min(0).max(1),
  finalReviewLocked: z.boolean(), skillBinding: SkillBindingSchema.optional(),
  skillTrace: SkillTraceDimensionsSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.skillTrace === undefined) return;
  if (value.skillBinding === undefined
    || value.skillTrace.skillId !== value.skillBinding.skillId
    || value.skillTrace.skillVersion !== value.skillBinding.version
    || value.skillTrace.pageFingerprintHash !== value.skillBinding.pageFingerprintHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["skillTrace"], message: "skill_trace_binding_mismatch" });
  }
});
export const AgentGraphStateSchema = z.object({
  threadId: z.string().min(1), runId: z.string().min(1), taskId: z.string().min(1),
  graphVersion: z.literal("agent-v1"), status: GraphStatusSchema,
  profileRevision: z.number().int().nonnegative(), expectationRevision: z.number().int().nonnegative().optional(),
  selectedJobId: z.string().optional(), currentSubgraph: SubgraphNameSchema,
  currentNode: z.string().optional(), pendingInterrupt: HumanInterruptSchema.optional(),
  resumeIngestion: ResumeIngestionStateSchema.optional(), jobMatching: JobMatchingStateSchema.optional(),
  application: ApplicationExecutionStateSchema.optional(), error: GraphErrorSchema.optional(),
  auditEventIds: z.array(z.string())
}).strict();
export const AuditTraceInputSchema = z.object({
  runId: TraceIdentifierSchema, taskId: TraceIdentifierSchema, node: TraceCodeSchema,
  kind: z.enum(["node", "tool_call", "model_decision", "interrupt", "checkpoint", "safety_block"]),
  outcome: TraceCodeSchema, reasonCode: TraceCodeSchema,
  confidence: z.number().min(0).max(1).optional(), candidateIds: z.array(TraceIdentifierSchema).max(100).optional(),
  evidenceIds: z.array(TraceIdentifierSchema).max(100).optional(), durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  counts: z.record(TraceCodeSchema, z.number().int().nonnegative()).optional(), contentHash: TraceIdentifierSchema.optional(),
  toolName: z.string().regex(/^[a-z0-9_:-]{1,80}$/u).optional(),
  errorCode: z.string().regex(/^[a-z0-9_:-]{1,80}$/u).optional(),
  skill: SkillTraceDimensionsSchema.optional()
}).strict();

export type GraphStatus = z.infer<typeof GraphStatusSchema>;
export type SubgraphName = z.infer<typeof SubgraphNameSchema>;
export type HumanInterrupt = z.infer<typeof HumanInterruptSchema>;
export type HumanResume = z.infer<typeof HumanResumeSchema>;
export type GraphError = z.infer<typeof GraphErrorSchema>;
export type ResumeIngestionState = z.infer<typeof ResumeIngestionStateSchema>;
export type JobRequirementAdvisoryState = z.infer<typeof JobRequirementAdvisoryStateSchema>;
export type JobMatchingState = z.infer<typeof JobMatchingStateSchema>;
export type ApplicationExecutionState = z.infer<typeof ApplicationExecutionStateSchema>;
export type AgentGraphState = z.infer<typeof AgentGraphStateSchema>;
export type SkillTraceDimensions = z.infer<typeof SkillTraceDimensionsSchema>;
export type AuditTraceInput = z.infer<typeof AuditTraceInputSchema>;
