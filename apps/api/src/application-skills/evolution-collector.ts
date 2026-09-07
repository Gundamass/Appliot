import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SkillEvaluationSchema,
  SkillExecutionRecordSchema,
  type SkillEvaluation,
  type SkillExecutionRecord
} from "@resume/contracts";
import {
  SKILL_EVALUATOR_VERSION,
  aggregateEvaluations,
  compareEvaluation,
  type AggregatedSkillEvaluation
} from "./evaluation-engine.js";

const IdentifierSchema = z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const VersionSchema = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const ScopeSchema = z.object({
  site: z.enum(["moka", "dji", "baidu"]),
  pageFingerprintHash: HashSchema,
  skillId: IdentifierSchema,
  version: VersionSchema
}).strict();
const FingerprintObservationSchema = z.object({
  observationId: IdentifierSchema,
  site: ScopeSchema.shape.site,
  pageFingerprintHash: HashSchema,
  observedAt: z.string().datetime(),
  hasUsableChampion: z.boolean()
}).strict();
const EvolutionCollectorInputSchema = z.object({
  scope: ScopeSchema,
  executionRecords: z.array(SkillExecutionRecordSchema),
  evaluations: z.array(SkillEvaluationSchema),
  fingerprintObservations: z.array(FingerprintObservationSchema),
  openOpportunityIds: z.array(IdentifierSchema)
}).strict();

export interface EvolutionScope {
  readonly site: "moka" | "dji" | "baidu";
  readonly pageFingerprintHash: string;
  readonly skillId: string;
  readonly version: string;
}

export interface FingerprintObservation {
  readonly observationId: string;
  readonly site: EvolutionScope["site"];
  readonly pageFingerprintHash: string;
  readonly observedAt: string;
  readonly hasUsableChampion: boolean;
}

export interface EvolutionCollectorInput {
  readonly scope: EvolutionScope;
  readonly executionRecords: readonly SkillExecutionRecord[];
  readonly evaluations: readonly SkillEvaluation[];
  readonly fingerprintObservations: readonly FingerprintObservation[];
  readonly openOpportunityIds: readonly string[];
}

export type EvolutionTrigger =
  | "repeated_actionable_failure"
  | "fingerprint_drift"
  | "challenger_repeated_recovery";

export interface EvolutionTheme {
  readonly pageVariantId: string;
  readonly semantic?: NonNullable<SkillExecutionRecord["firstError"]>["semantic"];
  readonly errorClass:
    | NonNullable<SkillExecutionRecord["firstError"]>["errorClass"]
    | "fingerprint_drift";
}

export interface EvolutionChainEntry {
  readonly recordId: string;
  readonly evaluationId: string;
  readonly completedAt: string;
  readonly evaluation: SkillEvaluation;
}

export interface FailToSuccessPair {
  readonly failureRecordId: string;
  readonly successRecordId: string;
  readonly distance: number;
}

export interface EvolutionOpportunity {
  readonly opportunityId: string;
  readonly scope: EvolutionScope;
  readonly theme: EvolutionTheme;
  readonly triggers: readonly EvolutionTrigger[];
  readonly occurrenceCount: number;
  readonly evidenceRecordIds: readonly string[];
  readonly executionChain: readonly EvolutionChainEntry[];
  readonly failToSuccessPair?: FailToSuccessPair;
  readonly aggregate: AggregatedSkillEvaluation | undefined;
}

interface EvaluatedExecution {
  readonly record: SkillExecutionRecord;
  readonly evaluation: SkillEvaluation;
}

const ACTIONABLE_ERRORS = new Set<NonNullable<SkillExecutionRecord["firstError"]>["errorClass"]>([
  "field_missing",
  "ambiguous_field",
  "stale_node_ref",
  "write_failed",
  "readback_mismatch",
  "audit_mismatch"
]);

export function collectEvolutionOpportunities(input: EvolutionCollectorInput): EvolutionOpportunity[] {
  const parsed = EvolutionCollectorInputSchema.parse(input);
  const scope = parsed.scope;
  const evaluated = latestEvaluatedExecutions(parsed, scope);
  const aggregate = evaluated.length === 0
    ? undefined
    : aggregateEvaluations(evaluated.map(({ evaluation }) => evaluation));
  const open = new Set(parsed.openOpportunityIds);
  const opportunities: EvolutionOpportunity[] = [];

  const groups = failureGroups(evaluated);
  for (const group of groups.values()) {
    const challengerRecoveryChain = monotonicChain(group.filter(({ record }) => (
      record.allocation === "challenger" && record.recoveries > 0
    )));
    const challengerRecovery = group.filter(({ record }) => (
      record.allocation === "challenger" && record.recoveries > 0
    )).length >= 3 && challengerRecoveryChain.length >= 2;
    const repeatedFailure = group.length >= 3;
    if (!challengerRecovery && !repeatedFailure) continue;

    const firstError = group[0]!.record.firstError!;
    const theme: EvolutionTheme = {
      pageVariantId: group[0]!.record.pageVariantId,
      ...(firstError.semantic === undefined ? {} : { semantic: firstError.semantic }),
      errorClass: firstError.errorClass
    };
    const opportunityId = opportunityIdFor(scope, theme);
    if (open.has(opportunityId)) continue;

    const pair = shortestFailToSuccessPair(group, evaluated);
    const executionChain = pair === undefined
      ? (challengerRecovery ? challengerRecoveryChain : monotonicChain(group))
      : pair.entries;
    opportunities.push(deepFreeze({
      opportunityId,
      scope,
      theme,
      triggers: [challengerRecovery ? "challenger_repeated_recovery" : "repeated_actionable_failure"],
      occurrenceCount: group.length,
      evidenceRecordIds: group.map(({ record }) => record.recordId),
      executionChain: executionChain.map(chainEntry),
      ...(pair === undefined ? {} : { failToSuccessPair: pair.summary }),
      aggregate
    }));
  }

  const driftObservations = uniqueFingerprintObservations(parsed.fingerprintObservations).filter((observation) => (
    observation.site === scope.site && observation.pageFingerprintHash === scope.pageFingerprintHash
  ));
  if (driftObservations.length >= 2 && driftObservations.every(({ hasUsableChampion }) => !hasUsableChampion)) {
    const theme: EvolutionTheme = { pageVariantId: "unknown", errorClass: "fingerprint_drift" };
    const opportunityId = opportunityIdFor(scope, theme);
    if (!open.has(opportunityId)) {
      opportunities.push(deepFreeze({
        opportunityId,
        scope,
        theme,
        triggers: ["fingerprint_drift"],
        occurrenceCount: driftObservations.length,
        evidenceRecordIds: [],
        executionChain: [],
        aggregate
      }));
    }
  }

  return deepFreeze(opportunities.sort((left, right) => left.opportunityId.localeCompare(right.opportunityId)));
}

function latestEvaluatedExecutions(
  input: z.infer<typeof EvolutionCollectorInputSchema>,
  scope: EvolutionScope
): EvaluatedExecution[] {
  const evaluations = uniqueEvaluations(input.evaluations);
  const records = uniqueScopedRecords(input.executionRecords, scope)
    .filter((record) => evaluations.has(record.recordId))
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt) || right.recordId.localeCompare(left.recordId))
    .slice(0, 20)
    .sort(compareExecutionTime);
  return records.flatMap((record) => {
    const evaluation = evaluations.get(record.recordId);
    return evaluation === undefined ? [] : [{ record, evaluation }];
  });
}

function uniqueScopedRecords(records: readonly SkillExecutionRecord[], scope: EvolutionScope): SkillExecutionRecord[] {
  const logicalAttempts = new Map<string, SkillExecutionRecord>();
  for (const record of records) {
    if (!matchesScope(record, scope)) continue;
    const key = [
      record.taskId,
      record.attemptId,
      record.binding.skillId,
      record.binding.version,
      record.binding.allocationId
    ].join("\0");
    const existing = logicalAttempts.get(key);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        throw new Error("skill_execution_duplicate_conflict");
      }
      continue;
    }
    logicalAttempts.set(key, record);
  }
  return [...logicalAttempts.values()];
}

function uniqueEvaluations(evaluations: readonly SkillEvaluation[]): Map<string, SkillEvaluation> {
  const unique = new Map<string, SkillEvaluation>();
  for (const evaluation of evaluations) {
    if (evaluation.evaluatorVersion !== SKILL_EVALUATOR_VERSION) continue;
    const existing = unique.get(evaluation.executionRecordId);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(evaluation)) {
      throw new Error("skill_evaluation_duplicate_conflict");
    }
    unique.set(evaluation.executionRecordId, evaluation);
  }
  return unique;
}

function failureGroups(evaluated: readonly EvaluatedExecution[]): Map<string, EvaluatedExecution[]> {
  const groups = new Map<string, EvaluatedExecution[]>();
  for (const item of evaluated) {
    const error = item.record.firstError;
    if (error === undefined || !ACTIONABLE_ERRORS.has(error.errorClass)) continue;
    const key = [
      item.record.pageVariantId,
      error.semantic ?? "page",
      error.errorClass
    ].join("\0");
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function monotonicChain(items: readonly EvaluatedExecution[]): EvaluatedExecution[] {
  const chain: EvaluatedExecution[] = [];
  for (const item of [...items].sort((left, right) => compareExecutionTime(left.record, right.record))) {
    const parent = chain.at(-1);
    if (parent === undefined || compareEvaluation(item.evaluation, parent.evaluation) === "left") {
      chain.push(item);
    }
  }
  return chain;
}

function shortestFailToSuccessPair(
  failures: readonly EvaluatedExecution[],
  all: readonly EvaluatedExecution[]
): { entries: [EvaluatedExecution, EvaluatedExecution]; summary: FailToSuccessPair } | undefined {
  const candidates: Array<{
    failure: EvaluatedExecution;
    success: EvaluatedExecution;
    distance: number;
    failureIndex: number;
  }> = [];
  for (const failure of failures) {
    const failureIndex = all.findIndex(({ record }) => record.recordId === failure.record.recordId);
    if (failureIndex < 0 || failure.evaluation.decision === "pass") continue;
    for (let successIndex = failureIndex + 1; successIndex < all.length; successIndex += 1) {
      const success = all[successIndex]!;
      if (success.evaluation.decision !== "pass"
        || compareEvaluation(success.evaluation, failure.evaluation) !== "left"
        || !matchesFailureTheme(success.record, failure.record)) continue;
      candidates.push({ failure, success, distance: successIndex - failureIndex, failureIndex });
    }
  }
  const selected = candidates.sort((left, right) => (
    left.distance - right.distance || right.failureIndex - left.failureIndex
  ))[0];
  if (selected === undefined) return undefined;
  return {
    entries: [selected.failure, selected.success],
    summary: {
      failureRecordId: selected.failure.record.recordId,
      successRecordId: selected.success.record.recordId,
      distance: selected.distance
    }
  };
}

function matchesFailureTheme(success: SkillExecutionRecord, failure: SkillExecutionRecord): boolean {
  if (success.pageVariantId !== failure.pageVariantId) return false;
  const semantic = failure.firstError?.semantic;
  return semantic === undefined || success.fieldOutcomes.some((outcome) => (
    outcome.semantic === semantic && outcome.outcome === "verified"
  ));
}

function uniqueFingerprintObservations(
  observations: readonly FingerprintObservation[]
): FingerprintObservation[] {
  const unique = new Map<string, FingerprintObservation>();
  for (const observation of observations) {
    const existing = unique.get(observation.observationId);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(observation)) {
      throw new Error("skill_fingerprint_observation_conflict");
    }
    unique.set(observation.observationId, observation);
  }
  return [...unique.values()].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt) || left.observationId.localeCompare(right.observationId)
  ));
}

function matchesScope(record: SkillExecutionRecord, scope: EvolutionScope): boolean {
  return record.binding.site === scope.site
    && record.binding.pageFingerprintHash === scope.pageFingerprintHash
    && record.binding.skillId === scope.skillId
    && record.binding.version === scope.version;
}

function compareExecutionTime(left: SkillExecutionRecord, right: SkillExecutionRecord): number {
  return left.completedAt.localeCompare(right.completedAt) || left.recordId.localeCompare(right.recordId);
}

function chainEntry(item: EvaluatedExecution): EvolutionChainEntry {
  return {
    recordId: item.record.recordId,
    evaluationId: item.evaluation.evaluationId,
    completedAt: item.record.completedAt,
    evaluation: item.evaluation
  };
}

function opportunityIdFor(scope: EvolutionScope, theme: EvolutionTheme): string {
  const hash = createHash("sha256")
    .update(canonicalJson({ schemaVersion: 1, scope, theme }), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `evolution-opportunity-${hash}`;
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
