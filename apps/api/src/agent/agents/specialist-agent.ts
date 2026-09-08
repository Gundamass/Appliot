import { z } from "zod";
import {
  CanonicalIntentSchema,
  EvidenceRefSchema,
  ObservationRefSchema,
  PlanStateSchema,
  PlanStepSchema,
  RuntimeHumanInterruptSchema,
  type CanonicalIntent,
  type EvidenceRef,
  type JsonValue,
  type ObservationRef,
  type PlanState,
  type PlanStep,
  type RuntimeHumanInterrupt
} from "@resume/contracts";
import type { CallerAttestationToken } from "../policy/caller-attestation.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/iu);

export const BrowserNodeRefSchema = z.union([
  z.string().min(1).max(512),
  z.record(z.string().min(1).max(128), z.union([z.string().max(512), z.number().finite(), z.boolean()]))
]);
export type BrowserNodeRef = z.infer<typeof BrowserNodeRefSchema>;

export const BrowserObservationSchema = z.object({
  snapshotId: z.string().min(1).max(256),
  executionEpoch: z.number().int().nonnegative(),
  targetFingerprint: z.string().min(1).max(256),
  nodeRefs: z.array(BrowserNodeRefSchema).max(10_000)
}).strict();
export type BrowserObservation = z.infer<typeof BrowserObservationSchema>;

export const ApplicationActionProposalSchema = z.object({
  snapshotId: z.string().min(1).max(256),
  executionEpoch: z.number().int().nonnegative(),
  targetFingerprint: z.string().min(1).max(256),
  nodeRef: BrowserNodeRefSchema,
  operation: z.enum(["fill", "select", "upload", "click_intermediate", "final_submit"]),
  fieldId: z.string().min(1).max(256).optional(),
  valueRef: z.string().min(1).max(256).optional()
}).strict();
export type ApplicationActionProposal = z.infer<typeof ApplicationActionProposalSchema>;

export const RequirementAdvisorySchema = z.object({
  requirementId: z.string().min(1).max(128),
  outcome: z.enum(["satisfied", "unknown", "conflict"]),
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string().min(1).max(128)).max(100).optional()
}).strict();
export type RequirementAdvisory = z.infer<typeof RequirementAdvisorySchema>;

export const SpecialistAgentResultSchema = z.object({
  status: z.enum(["completed", "blocked", "failed", "interrupted"]),
  outputRef: z.string().min(1).max(256).optional(),
  evidenceRefs: z.array(EvidenceRefSchema).max(500),
  observationRefs: z.array(ObservationRefSchema).max(100).optional(),
  advisories: z.array(RequirementAdvisorySchema).max(100).optional(),
  pendingInterrupt: RuntimeHumanInterruptSchema.optional(),
  blockReason: z.string().regex(/^[a-z0-9_:-]{1,120}$/u).optional(),
  errorCode: z.string().regex(/^[a-z0-9_:-]{1,120}$/u).optional(),
  payloadHash: HashSchema.optional(),
  submitted: z.literal(false).optional()
}).strict().superRefine((result, context) => {
  if (result.status === "completed" && result.outputRef === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "completed_result_requires_output_ref" });
  }
  if (result.status === "blocked" && result.blockReason === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "blocked_result_requires_reason" });
  }
  if (result.status === "failed" && result.errorCode === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "failed_result_requires_error_code" });
  }
  if (result.status === "interrupted" && result.pendingInterrupt === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "interrupted_result_requires_interrupt" });
  }
  if (result.status !== "interrupted" && result.pendingInterrupt !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "interrupt_only_allowed_for_interrupted_result" });
  }
});
export type SpecialistAgentResult = z.infer<typeof SpecialistAgentResultSchema>;

export interface SpecialistAgentInput {
  readonly runId: string;
  readonly taskId: string;
  readonly intent: CanonicalIntent;
  readonly plan: PlanState;
  readonly step: PlanStep;
  readonly signal: AbortSignal;
  readonly executionEpoch: number;
  readonly input?: JsonValue;
  readonly observation?: BrowserObservation;
  readonly humanResume?: { readonly interruptId: string; readonly action: string; readonly values: Record<string, JsonValue> };
  readonly callerAttestation?: CallerAttestationToken;
}

export const SpecialistAgentInputShape = {
  intent: CanonicalIntentSchema,
  plan: PlanStateSchema,
  step: PlanStepSchema
} as const;

export interface SpecialistAgent {
  readonly name: string;
  readonly version: string;
  execute(input: SpecialistAgentInput): Promise<SpecialistAgentResult>;
}

export function parseSpecialistAgentResult(value: unknown): SpecialistAgentResult {
  return SpecialistAgentResultSchema.parse(value);
}

export function publicEvidenceRef(value: EvidenceRef): EvidenceRef {
  return EvidenceRefSchema.parse({
    id: value.id,
    kind: value.kind,
    sourceRef: value.sourceRef,
    contentHash: value.contentHash,
    ...(value.locator === undefined ? {} : { locator: value.locator })
  });
}

export function emptySpecialistResult(
  status: SpecialistAgentResult["status"],
  details: Partial<SpecialistAgentResult> = {}
): SpecialistAgentResult {
  return SpecialistAgentResultSchema.parse({ status, evidenceRefs: [], ...details });
}

export function interruptForSpecialist(
  input: Pick<SpecialistAgentInput, "runId" | "step" | "executionEpoch">,
  reason: RuntimeHumanInterrupt["reason"],
  summary: string,
  relatedFields: readonly string[] = [],
  now: () => string = () => new Date().toISOString()
): RuntimeHumanInterrupt {
  const questionIds = [...new Set(relatedFields)].slice(0, 50);
  return RuntimeHumanInterruptSchema.parse({
    interruptId: `specialist:${input.runId}:${input.step.id}:${input.executionEpoch}`,
    reason,
    summary: summary.trim().slice(0, 2_000) || "Human review is required.",
    evidenceRefs: [],
    proposedAction: {
      stepId: input.step.id,
      executionEpoch: input.executionEpoch,
      ...(questionIds.length === 0 ? {} : { relatedFields: questionIds })
    },
    expiresAt: new Date(Date.parse(now()) + 15 * 60 * 1_000).toISOString()
  });
}

export function validateSpecialistInput(input: SpecialistAgentInput): void {
  CanonicalIntentSchema.parse(input.intent);
  PlanStateSchema.parse(input.plan);
  PlanStepSchema.parse(input.step);
  if (input.plan.intentId !== input.intent.intentId) throw new Error("specialist_intent_plan_mismatch");
  if (!input.plan.steps.some((step) => step.id === input.step.id)) throw new Error("specialist_step_missing");
  if (!Number.isInteger(input.executionEpoch) || input.executionEpoch < 0) {
    throw new Error("specialist_execution_epoch_invalid");
  }
}

export function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}
