import { z } from "zod";
import { JsonValueSchema, type JsonValue } from "./profile.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/iu);

export const EvidenceRefSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(["document", "observation", "action", "review", "memory"]),
  sourceRef: z.string().min(1).max(256),
  contentHash: HashSchema,
  locator: z.string().min(1).max(512).optional()
}).strict();

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ObservationRefSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(["browser", "job", "document", "profile", "tool"]),
  sourceRef: z.string().min(1).max(256),
  contentHash: HashSchema,
  snapshotId: z.string().min(1).max(256).optional(),
  executionEpoch: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime()
}).strict();

export type ObservationRef = z.infer<typeof ObservationRefSchema>;

export const MemoryRefSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(["profile_fact", "preference", "task_memory", "execution_observation"]),
  contentHash: HashSchema,
  sourceRef: z.string().min(1).max(256),
  revision: z.number().int().positive()
}).strict();

export type MemoryRef = z.infer<typeof MemoryRefSchema>;

export const RuntimeHumanInterruptSchema = z.object({
  interruptId: z.string().min(1).max(128),
  reason: z.enum([
    "final_submit",
    "ambiguous_fact",
    "authentication",
    "captcha",
    "prompt_injection",
    "high_risk_action",
    "budget_exceeded"
  ]),
  summary: z.string().min(1).max(2_000),
  evidenceRefs: z.array(z.string().min(1).max(128)).max(100),
  proposedAction: JsonValueSchema.optional(),
  expiresAt: z.string().datetime()
}).strict();

export type RuntimeHumanInterrupt = z.infer<typeof RuntimeHumanInterruptSchema>;

export const RuntimeHumanResumeSchema = z.object({
  interruptId: z.string().min(1).max(128),
  action: z.enum(["confirm", "correct", "approve", "reject", "cancel"]),
  values: z.record(z.string().min(1).max(128), JsonValueSchema)
}).strict();

export type RuntimeHumanResume = z.infer<typeof RuntimeHumanResumeSchema>;

export const RuntimeErrorSchema = z.object({
  code: z.string().regex(/^[a-z0-9_:-]{1,120}$/u),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
  stepId: z.string().min(1).max(128).optional(),
  detailHash: HashSchema.optional()
}).strict();

export type RuntimeError = z.infer<typeof RuntimeErrorSchema>;

export const AgentRunStatusSchema = z.enum([
  "running",
  "interrupted",
  "completed",
  "blocked",
  "failed",
  "cancelled",
  "expired"
]);

export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentRunTerminalStateSchema = z.enum(["completed", "blocked", "failed", "cancelled", "expired"]);
export type AgentRunTerminalState = z.infer<typeof AgentRunTerminalStateSchema>;

export const BudgetStateSchema = z.object({
  steps: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  replans: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative()
}).strict();

export type BudgetState = z.infer<typeof BudgetStateSchema>;

export const BudgetLimitsSchema = z.object({
  maxAttemptsPerStep: z.number().int().positive(),
  maxRetries: z.number().int().positive().default(64),
  maxReplans: z.number().int().positive(),
  maxSteps: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  maxDurationMs: z.number().int().positive()
}).strict();

export type BudgetLimits = z.infer<typeof BudgetLimitsSchema>;

export const AgentRunInputSchema = z.object({
  goal: z.string().min(1).max(20_000),
  requestedBy: z.string().min(1).max(256),
  contextRefs: z.array(z.string().min(1).max(256)).max(100).default([]),
  autonomyLevel: z.enum(["suggest", "prepare", "execute_with_approval"]).optional(),
  budget: BudgetLimitsSchema.partial().optional(),
  metadata: z.record(z.string().min(1).max(128), JsonValueSchema).optional()
}).strict();

export type AgentRunInput = z.infer<typeof AgentRunInputSchema>;

export const RuntimeCheckpointSchema = z.object({
  version: z.string().min(1).max(32),
  runId: z.string().min(1).max(128),
  intentId: z.string().min(1).max(128).optional(),
  planId: z.string().min(1).max(128).optional(),
  planRevision: z.number().int().positive().optional(),
  executionEpoch: z.number().int().nonnegative(),
  status: AgentRunStatusSchema,
  currentStepId: z.string().min(1).max(128).optional(),
  intentRef: z.string().min(1).max(256).optional(),
  planRef: z.string().min(1).max(256).optional(),
  phase: z.enum(["intent", "plan", "dispatch", "wait", "inspect", "human_gate", "complete", "blocked", "fail", "cancelled"]).optional(),
  memoryRefs: z.array(MemoryRefSchema).max(200),
  evidenceRefs: z.array(EvidenceRefSchema).max(500),
  pendingInterrupt: RuntimeHumanInterruptSchema.optional(),
  budget: BudgetStateSchema,
  budgetLimits: BudgetLimitsSchema.optional(),
  completedActionIds: z.array(z.string().min(1).max(128)).max(500),
  stateHash: HashSchema,
  createdAt: z.string().datetime()
}).strict();

export type RuntimeCheckpoint = z.infer<typeof RuntimeCheckpointSchema>;

export const AgentRunResultSchema = z.object({
  runId: z.string().min(1).max(128),
  status: AgentRunStatusSchema,
  intentId: z.string().min(1).max(128).optional(),
  planId: z.string().min(1).max(128).optional(),
  planRevision: z.number().int().positive().optional(),
  pendingInterrupt: RuntimeHumanInterruptSchema.optional(),
  summary: z.string().max(4_000).optional(),
  evidenceRefs: z.array(EvidenceRefSchema).max(500).optional(),
  error: RuntimeErrorSchema.optional(),
  eventCursor: z.string().min(1).max(256).optional()
}).strict().superRefine((result, context) => {
  if (result.status === "interrupted" && result.pendingInterrupt === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "interrupted_result_requires_pending_interrupt" });
  }
  if (result.status !== "interrupted" && result.pendingInterrupt !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "pending_interrupt_only_allowed_for_interrupted_result" });
  }
  if (result.status === "failed" && result.error === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "failed_result_requires_error" });
  }
});

export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;

export const RuntimeSnapshotSchema = z.object({
  runId: z.string().min(1).max(128),
  status: AgentRunStatusSchema,
  checkpoint: RuntimeCheckpointSchema,
  updatedAt: z.string().datetime(),
  eventCursor: z.string().min(1).max(256).optional()
}).strict();

export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>;

export type JsonObject = { [key: string]: JsonValue };
