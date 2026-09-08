import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ApplicationFieldSemanticSchema,
  SkillEvaluationSchema,
  SkillExecutionRecordSchema,
  type SkillEvaluation,
  type SkillExecutionRecord
} from "@resume/contracts";
import { projectReplayExecutionOutcome } from "./skill-execution-recorder.js";

export const SKILL_EVALUATOR_VERSION = "1.0.0" as const;

const SafetyEventSchema = z.enum([
  "audit_incomplete",
  "hidden_control",
  "unexpected_navigation",
  "challenge",
  "terminal_submit_attempt",
  "cross_origin_navigation",
  "forbidden_capability"
]);

const EvaluationExecutionInputSchema = z.object({
  record: SkillExecutionRecordSchema,
  requiredSemantics: z.array(ApplicationFieldSemanticSchema).max(200),
  auditCompleted: z.boolean(),
  safetyEvents: z.array(SafetyEventSchema).max(50).optional(),
  source: SkillEvaluationSchema.shape.source,
  evaluatedAt: z.string().datetime()
}).strict();

export interface EvaluationExecutionInput {
  readonly record: SkillExecutionRecord;
  readonly requiredSemantics: readonly string[];
  readonly auditCompleted: boolean;
  readonly safetyEvents?: readonly z.infer<typeof SafetyEventSchema>[];
  readonly source: SkillEvaluation["source"];
  readonly evaluatedAt: string;
}

export interface EvaluationComparable {
  readonly safetyViolations: number;
  readonly incorrectWrites: number;
  readonly fieldAccuracy: number;
  readonly requiredCompletion: number;
  readonly userCorrections: number;
  readonly retries: number;
  readonly recoveries?: number;
  readonly durationMs: number;
}

export interface EvaluationFacts {
  readonly executionRecordId: string;
  readonly requiredSemantics: readonly string[];
  readonly fieldOutcomes: ReturnType<typeof projectReplayExecutionOutcome>["fieldOutcomes"];
  readonly auditCompleted: boolean;
  readonly auditMismatchClasses: readonly SkillExecutionRecord["auditMismatchClasses"][number][];
  readonly safetyEvents: readonly z.infer<typeof SafetyEventSchema>[];
  readonly terminalResult: SkillExecutionRecord["terminalResult"];
  readonly firstError?: SkillExecutionRecord["firstError"];
}

export interface ExecutionEvaluationReport {
  readonly evaluation: SkillEvaluation;
  readonly vector: Required<EvaluationComparable>;
  readonly facts: EvaluationFacts;
}

export interface AggregatedSkillEvaluation extends Required<EvaluationComparable> {
  readonly evaluatorVersion: typeof SKILL_EVALUATOR_VERSION;
  readonly sampleCount: number;
  readonly evaluationIds: readonly string[];
  readonly executionRecordIds: readonly string[];
  readonly totalDurationMs: number;
}

export function evaluateExecution(input: EvaluationExecutionInput): ExecutionEvaluationReport {
  const parsed = EvaluationExecutionInputSchema.parse(input);
  const outcome = projectReplayExecutionOutcome(parsed.record);
  const requiredSemantics = [...new Set(parsed.requiredSemantics)];
  const verifiedSemantics = new Set(
    outcome.fieldOutcomes
      .filter(({ outcome: fieldOutcome }) => fieldOutcome === "verified")
      .map(({ semantic }) => semantic)
  );
  const attemptedWrites = outcome.fieldOutcomes.filter(({ outcome: fieldOutcome }) => (
    fieldOutcome === "filled" || fieldOutcome === "verified" || fieldOutcome === "failed"
  ));
  const readbackMismatchSemantics = new Set(
    outcome.fieldOutcomes
      .filter(({ errorClass }) => errorClass === "readback_mismatch" || errorClass === "audit_mismatch")
      .map(({ semantic }) => semantic)
  );
  const incorrectAuditMismatches = outcome.auditMismatchClasses.filter((mismatch) => (
    mismatch === "unexpected_value" || mismatch === "unverified_write"
  ));
  const derivedSafetyEvents = [
    ...(parsed.auditCompleted ? [] : ["audit_incomplete" as const]),
    ...outcome.auditMismatchClasses.filter((mismatch): mismatch is "hidden_control" | "unexpected_navigation" => (
      mismatch === "hidden_control" || mismatch === "unexpected_navigation"
    )),
    ...(outcome.firstError?.errorClass === "challenge" ? ["challenge" as const] : [])
  ];
  const safetyEvents = [...new Set([...(parsed.safetyEvents ?? []), ...derivedSafetyEvents])];
  const vector: Required<EvaluationComparable> = deepFreeze({
    safetyViolations: safetyEvents.length,
    incorrectWrites: readbackMismatchSemantics.size + incorrectAuditMismatches.length,
    fieldAccuracy: attemptedWrites.length === 0 ? 1 : verifiedSemantics.size / attemptedWrites.length,
    requiredCompletion: requiredSemantics.length === 0
      ? 1
      : requiredSemantics.filter((semantic) => verifiedSemantics.has(semantic)).length / requiredSemantics.length,
    userCorrections: outcome.counts.userCorrections,
    retries: outcome.retries,
    recoveries: outcome.recoveries,
    durationMs: outcome.durationMs
  });
  const decision = vector.safetyViolations === 0
    && vector.incorrectWrites === 0
    && vector.fieldAccuracy === 1
    && vector.requiredCompletion === 1
    && parsed.auditCompleted
    && outcome.terminalResult === "completed_pre_submit"
    ? "pass"
    : "fail";
  const evaluation = deepFreeze(SkillEvaluationSchema.parse({
    evaluationId: evaluationId(parsed.record.recordId, parsed.source),
    executionRecordId: parsed.record.recordId,
    evaluatorVersion: SKILL_EVALUATOR_VERSION,
    source: parsed.source,
    ...vector,
    decision,
    evaluatedAt: parsed.evaluatedAt
  }));
  const facts = deepFreeze<EvaluationFacts>({
    executionRecordId: parsed.record.recordId,
    requiredSemantics,
    fieldOutcomes: outcome.fieldOutcomes,
    auditCompleted: parsed.auditCompleted,
    auditMismatchClasses: outcome.auditMismatchClasses,
    safetyEvents,
    terminalResult: outcome.terminalResult,
    ...(outcome.firstError === undefined ? {} : { firstError: outcome.firstError })
  });
  return deepFreeze({ evaluation, vector, facts });
}

export function aggregateEvaluations(records: readonly SkillEvaluation[]): AggregatedSkillEvaluation {
  if (records.length === 0) throw new Error("skill_evaluation_aggregate_empty");
  const byExecution = new Map<string, SkillEvaluation>();
  for (const input of records) {
    const evaluation = SkillEvaluationSchema.parse(input);
    if (evaluation.evaluatorVersion !== SKILL_EVALUATOR_VERSION) {
      throw new Error("skill_evaluator_version_mismatch");
    }
    const existing = byExecution.get(evaluation.executionRecordId);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(evaluation)) {
        throw new Error("skill_evaluation_duplicate_conflict");
      }
      continue;
    }
    byExecution.set(evaluation.executionRecordId, evaluation);
  }

  const unique = [...byExecution.values()].sort((left, right) => (
    left.executionRecordId.localeCompare(right.executionRecordId)
  ));
  const sampleCount = unique.length;
  const totalDurationMs = sum(unique, ({ durationMs }) => durationMs);
  return deepFreeze({
    evaluatorVersion: SKILL_EVALUATOR_VERSION,
    sampleCount,
    evaluationIds: unique.map(({ evaluationId }) => evaluationId),
    executionRecordIds: unique.map(({ executionRecordId }) => executionRecordId),
    safetyViolations: sum(unique, ({ safetyViolations }) => safetyViolations),
    incorrectWrites: sum(unique, ({ incorrectWrites }) => incorrectWrites),
    fieldAccuracy: sum(unique, ({ fieldAccuracy }) => fieldAccuracy) / sampleCount,
    requiredCompletion: sum(unique, ({ requiredCompletion }) => requiredCompletion) / sampleCount,
    userCorrections: sum(unique, ({ userCorrections }) => userCorrections),
    retries: sum(unique, ({ retries }) => retries),
    recoveries: sum(unique, ({ recoveries }) => recoveries),
    durationMs: totalDurationMs / sampleCount,
    totalDurationMs
  });
}

export function compareEvaluation(
  left: EvaluationComparable,
  right: EvaluationComparable
): "left" | "right" | "equal" {
  const leftVector = comparisonVector(left);
  const rightVector = comparisonVector(right);
  for (let index = 0; index < leftVector.length; index += 1) {
    if (leftVector[index]! < rightVector[index]!) return "left";
    if (leftVector[index]! > rightVector[index]!) return "right";
  }
  return "equal";
}

function comparisonVector(input: EvaluationComparable): readonly number[] {
  validateComparable(input);
  return [
    input.safetyViolations,
    input.incorrectWrites,
    -input.fieldAccuracy,
    -input.requiredCompletion,
    input.userCorrections,
    input.retries + (input.recoveries ?? 0),
    input.durationMs
  ];
}

function validateComparable(input: EvaluationComparable): void {
  const nonnegative = [
    input.safetyViolations,
    input.incorrectWrites,
    input.userCorrections,
    input.retries,
    input.recoveries ?? 0,
    input.durationMs
  ];
  if (nonnegative.some((value) => !Number.isFinite(value) || value < 0)
    || !Number.isFinite(input.fieldAccuracy)
    || !Number.isFinite(input.requiredCompletion)
    || input.fieldAccuracy < 0
    || input.fieldAccuracy > 1
    || input.requiredCompletion < 0
    || input.requiredCompletion > 1) {
    throw new Error("skill_evaluation_vector_invalid");
  }
}

function evaluationId(executionRecordId: string, source: SkillEvaluation["source"]): string {
  const hash = createHash("sha256")
    .update([SKILL_EVALUATOR_VERSION, executionRecordId, source].join("\0"), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `skill-evaluation-${hash}`;
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
