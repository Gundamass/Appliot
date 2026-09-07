import { createHash } from "node:crypto";
import { SkillEvaluationSchema, type SkillEvaluation } from "@resume/contracts";

export type ChallengerDecision = "insufficient" | "continue" | "promote" | "rollback" | "stop-inconclusive";
export type ComparisonDimension =
  | "safetyViolations"
  | "incorrectWrites"
  | "newAuditMismatches"
  | "fieldAccuracy"
  | "requiredCompletion"
  | "userCorrections"
  | "retriesAndRecoveries"
  | "durationMs";

export interface StratifiedEvaluationSample {
  readonly executionId: string;
  readonly site: "moka" | "dji" | "baidu";
  readonly pageFingerprintHash: string;
  readonly scenarioClass: string;
  readonly requiredFieldCount: number;
  readonly newAuditMismatches: number;
  readonly evaluation: SkillEvaluation;
}

export interface StratifiedBootstrapInput {
  readonly allocationId: string;
  readonly evaluatorVersion: string;
  readonly iterations?: number;
  readonly champion: readonly StratifiedEvaluationSample[];
  readonly challenger: readonly StratifiedEvaluationSample[];
}

export interface StratifiedBootstrapResult {
  readonly championCount: number;
  readonly challengerCount: number;
  readonly eligibleChallengerCount: number;
  readonly stratumCount: number;
  readonly firstDifferingDimension?: ComparisonDimension;
  readonly observedDelta: number;
  readonly confidenceInterval95: readonly [number, number];
  readonly decision: ChallengerDecision;
}

const SOFT_DIMENSIONS: readonly ComparisonDimension[] = [
  "fieldAccuracy", "requiredCompletion", "userCorrections", "retriesAndRecoveries", "durationMs"
];

export function stratifiedBootstrapComparison(input: StratifiedBootstrapInput): StratifiedBootstrapResult {
  const iterations = input.iterations ?? 10_000;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) {
    throw new Error("skill_statistics_iterations_invalid");
  }
  if (input.allocationId.trim() === "" || input.evaluatorVersion.trim() === "") {
    throw new Error("skill_statistics_identity_invalid");
  }
  const champion = normalize(input.champion, input.evaluatorVersion);
  const challenger = normalize(input.challenger, input.evaluatorVersion);
  const strata = pairedStrata(champion, challenger);
  const eligibleChallengerCount = strata.reduce((total, stratum) => total + stratum.challenger.length, 0);
  const base = {
    championCount: champion.length,
    challengerCount: challenger.length,
    eligibleChallengerCount,
    stratumCount: strata.length
  };

  const hard = hardFailure(challenger);
  if (hard !== undefined) {
    return freeze({ ...base, firstDifferingDimension: hard.dimension, observedDelta: -hard.count,
      confidenceInterval95: [-hard.count, -hard.count], decision: "rollback" });
  }
  if (eligibleChallengerCount < 10 || strata.length === 0) {
    return freeze({ ...base, observedDelta: 0, confidenceInterval95: [0, 0], decision: "insufficient" });
  }

  const deltas = SOFT_DIMENSIONS.map((dimension) => ({
    dimension,
    delta: observedDelta(strata, dimension)
  }));
  const firstIndex = deltas.findIndex(({ delta }) => Math.abs(delta) > 1e-12);
  if (firstIndex < 0) return freeze({
    ...base,
    observedDelta: 0,
    confidenceInterval95: [0, 0],
    decision: inconclusiveDecision(eligibleChallengerCount)
  });

  const selected = deltas[firstIndex]!;
  const interval = bootstrapInterval(
    strata,
    selected.dimension,
    iterations,
    `${input.allocationId}${input.evaluatorVersion}${selected.dimension}`
  );
  const higherPriorityNonInferior = deltas.slice(0, firstIndex).every(({ dimension, delta }) => {
    if (delta < -1e-12) return false;
    const higherInterval = bootstrapInterval(
      strata,
      dimension,
      iterations,
      `${input.allocationId}${input.evaluatorVersion}${dimension}`
    );
    return higherInterval[0] >= -1e-12;
  });
  const decision: ChallengerDecision = interval[1] < 0
    ? "rollback"
    : interval[0] > 0 && higherPriorityNonInferior
      ? "promote"
      : inconclusiveDecision(eligibleChallengerCount);
  return freeze({
    ...base,
    firstDifferingDimension: selected.dimension,
    observedDelta: rounded(selected.delta),
    confidenceInterval95: interval,
    decision
  });
}

interface NormalizedSample extends StratifiedEvaluationSample { readonly evaluation: SkillEvaluation }
interface Stratum { readonly champion: readonly NormalizedSample[]; readonly challenger: readonly NormalizedSample[]; readonly weight: number }

function normalize(samples: readonly StratifiedEvaluationSample[], evaluatorVersion: string): NormalizedSample[] {
  const byId = new Map<string, NormalizedSample>();
  for (const sample of samples) {
    const evaluation = SkillEvaluationSchema.parse(sample.evaluation);
    if (evaluation.evaluatorVersion !== evaluatorVersion || evaluation.executionRecordId !== sample.executionId) {
      throw new Error("skill_statistics_evaluation_mismatch");
    }
    if (!Number.isInteger(sample.requiredFieldCount) || sample.requiredFieldCount < 0
      || !Number.isInteger(sample.newAuditMismatches) || sample.newAuditMismatches < 0) {
      throw new Error("skill_statistics_sample_invalid");
    }
    if (byId.has(sample.executionId)) throw new Error("skill_statistics_duplicate_execution");
    byId.set(sample.executionId, { ...sample, evaluation });
  }
  return [...byId.values()].sort((left, right) => left.executionId.localeCompare(right.executionId));
}

function pairedStrata(champion: readonly NormalizedSample[], challenger: readonly NormalizedSample[]): Stratum[] {
  const left = group(champion);
  const right = group(challenger);
  const keys = [...left.keys()].filter((key) => right.has(key)).sort();
  const total = keys.reduce((sum, key) => sum + left.get(key)!.length + right.get(key)!.length, 0);
  return keys.map((key) => ({
    champion: left.get(key)!,
    challenger: right.get(key)!,
    weight: (left.get(key)!.length + right.get(key)!.length) / total
  }));
}

function group(samples: readonly NormalizedSample[]): Map<string, NormalizedSample[]> {
  const groups = new Map<string, NormalizedSample[]>();
  for (const sample of samples) {
    const key = [sample.site, sample.pageFingerprintHash, sample.scenarioClass, fieldBand(sample.requiredFieldCount)].join("\0");
    const values = groups.get(key) ?? [];
    values.push(sample);
    groups.set(key, values);
  }
  return groups;
}

function fieldBand(count: number): string {
  if (count === 0) return "0";
  if (count <= 3) return "1-3";
  if (count <= 7) return "4-7";
  return "8+";
}

function hardFailure(samples: readonly NormalizedSample[]): { dimension: ComparisonDimension; count: number } | undefined {
  const safety = samples.reduce((sum, sample) => sum + sample.evaluation.safetyViolations, 0);
  if (safety > 0) return { dimension: "safetyViolations", count: safety };
  const writes = samples.reduce((sum, sample) => sum + sample.evaluation.incorrectWrites, 0);
  if (writes > 0) return { dimension: "incorrectWrites", count: writes };
  const mismatches = samples.reduce((sum, sample) => sum + sample.newAuditMismatches, 0);
  return mismatches > 0 ? { dimension: "newAuditMismatches", count: mismatches } : undefined;
}

function observedDelta(strata: readonly Stratum[], dimension: ComparisonDimension): number {
  return strata.reduce((sum, stratum) => sum + stratum.weight * (
    mean(stratum.challenger.map((sample) => utility(sample, dimension)))
    - mean(stratum.champion.map((sample) => utility(sample, dimension)))
  ), 0);
}

function bootstrapInterval(strata: readonly Stratum[], dimension: ComparisonDimension, iterations: number, seed: string): [number, number] {
  const random = prng(seed);
  const values = Array.from({ length: iterations }, () => strata.reduce((sum, stratum) => sum + stratum.weight * (
    resampledMean(stratum.challenger, dimension, random) - resampledMean(stratum.champion, dimension, random)
  ), 0)).sort((left, right) => left - right);
  return [rounded(values[Math.floor((iterations - 1) * 0.025)]!), rounded(values[Math.floor((iterations - 1) * 0.975)]!)];
}

function resampledMean(samples: readonly NormalizedSample[], dimension: ComparisonDimension, random: () => number): number {
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) total += utility(samples[Math.floor(random() * samples.length)]!, dimension);
  return total / samples.length;
}

function utility(sample: NormalizedSample, dimension: ComparisonDimension): number {
  switch (dimension) {
    case "fieldAccuracy": return sample.evaluation.fieldAccuracy;
    case "requiredCompletion": return sample.evaluation.requiredCompletion;
    case "userCorrections": return -sample.evaluation.userCorrections;
    case "retriesAndRecoveries": return -(sample.evaluation.retries + sample.evaluation.recoveries);
    case "durationMs": return -sample.evaluation.durationMs;
    case "safetyViolations": return -sample.evaluation.safetyViolations;
    case "incorrectWrites": return -sample.evaluation.incorrectWrites;
    case "newAuditMismatches": return -sample.newAuditMismatches;
  }
}

function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function inconclusiveDecision(count: number): ChallengerDecision { return count >= 50 ? "stop-inconclusive" : "continue"; }
function rounded(value: number): number { return Object.is(value, -0) ? 0 : Number(value.toFixed(12)); }

function prng(seed: string): () => number {
  let state = createHash("sha256").update(seed, "utf8").digest().readUInt32BE(0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function freeze<T>(value: T): T { return Object.freeze(value); }
