import { z } from "zod";
import { JsonValueSchema } from "./profile.js";
import { RuntimeHumanInterruptSchema } from "./agent-runtime.js";

export const PlanStepOwnerSchema = z.enum(["resume", "job_matching", "application", "review"]);
export type PlanStepOwner = z.infer<typeof PlanStepOwnerSchema>;

export const PlanStepStatusSchema = z.enum(["pending", "running", "completed", "blocked", "skipped"]);
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;

export const PlanRiskSchema = z.enum(["low", "medium", "high", "irreversible"]);

export const PlanStepSchema = z.object({
  id: z.string().min(1).max(128),
  objective: z.string().min(1).max(2_000),
  owner: PlanStepOwnerSchema,
  status: PlanStepStatusSchema,
  dependsOn: z.array(z.string().min(1).max(128)).max(32),
  inputRefs: z.array(z.string().min(1).max(256)).max(100),
  outputRefs: z.array(z.string().min(1).max(256)).max(100),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  acceptanceCriteria: z.array(z.string().min(1).max(1_000)).max(50),
  risk: PlanRiskSchema,
  capabilityNames: z.array(z.string().regex(/^[a-z0-9_.:-]{1,120}$/u)).max(20).optional()
}).strict();

export type PlanStep = z.infer<typeof PlanStepSchema>;

export const ApprovalPointSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(["final_submit", "high_risk_action", "fact_conflict", "authentication", "prompt_injection"]),
  stepId: z.string().min(1).max(128),
  required: z.boolean()
}).strict();

export type ApprovalPoint = z.infer<typeof ApprovalPointSchema>;

export const PlanAssumptionSchema = z.object({
  id: z.string().min(1).max(128),
  statement: z.string().min(1).max(2_000),
  source: z.enum(["user", "evidence", "memory", "inference"]),
  confidence: z.number().min(0).max(1),
  invalidationConditions: z.array(z.string().min(1).max(500)).max(20)
}).strict();

export type PlanAssumption = z.infer<typeof PlanAssumptionSchema>;

export const PlanCostEstimateSchema = z.object({
  steps: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative()
}).strict();

export type PlanCostEstimate = z.infer<typeof PlanCostEstimateSchema>;

export const PlanRevisionRefSchema = z.object({
  revision: z.number().int().positive(),
  planRef: z.string().min(1).max(256),
  reason: z.string().min(1).max(2_000),
  createdAt: z.string().datetime()
}).strict();

export const PlanStateSchema = z.object({
  planId: z.string().min(1).max(128),
  intentId: z.string().min(1).max(128),
  revision: z.number().int().positive(),
  previousRevision: z.number().int().positive().optional(),
  steps: z.array(PlanStepSchema).max(100),
  assumptions: z.array(PlanAssumptionSchema).max(100),
  approvalPoints: z.array(ApprovalPointSchema).max(50),
  estimatedCost: PlanCostEstimateSchema,
  revisionHistory: z.array(PlanRevisionRefSchema).max(100).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export type PlanState = z.infer<typeof PlanStateSchema>;

export const PlanProposalSchema = PlanStateSchema;
export type PlanProposal = z.infer<typeof PlanProposalSchema>;

export const ReplanRequestSchema = z.object({
  reason: z.string().min(1).max(2_000),
  failedStepId: z.string().min(1).max(128).optional(),
  observationRefs: z.array(z.string().min(1).max(128)).max(100),
  preservedOutputRefs: z.array(z.string().min(1).max(256)).max(100)
}).strict();

export type ReplanRequest = z.infer<typeof ReplanRequestSchema>;

export const SupervisorDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("dispatch_agent"),
    agent: z.string().regex(/^[a-z][a-z0-9_:-]{1,80}$/u),
    input: JsonValueSchema,
    reason: z.string().min(1).max(2_000)
  }).strict(),
  z.object({
    type: z.literal("invoke_tool"),
    capability: z.string().regex(/^[a-z][a-z0-9_.:-]{1,120}$/u),
    input: JsonValueSchema,
    reason: z.string().min(1).max(2_000)
  }).strict(),
  z.object({ type: z.literal("ask_human"), interrupt: RuntimeHumanInterruptSchema }).strict(),
  z.object({
    type: z.literal("finish"),
    outcome: z.enum(["completed", "blocked"]),
    summary: z.string().min(1).max(4_000)
  }).strict(),
  z.object({
    type: z.literal("fail"),
    code: z.string().regex(/^[a-z0-9_:-]{1,120}$/u),
    retryable: z.boolean()
  }).strict()
]);

export type SupervisorDecision = z.infer<typeof SupervisorDecisionSchema>;
