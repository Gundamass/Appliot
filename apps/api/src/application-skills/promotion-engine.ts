import {
  SkillEvaluationSchema,
  SkillExecutionRecordSchema,
  type ApplicationSkillVersion,
  type SkillEvaluation,
  type SkillExecutionRecord
} from "@resume/contracts";
import type { SkillPageAllocation } from "./skill-selector.js";
import {
  stratifiedBootstrapComparison,
  type StratifiedBootstrapInput,
  type StratifiedBootstrapResult,
  type StratifiedEvaluationSample
} from "./statistics.js";

export interface PromotionEvaluationSample {
  readonly record: SkillExecutionRecord;
  readonly evaluation: SkillEvaluation;
  readonly scenarioClass: string;
  readonly requiredFieldCount: number;
  readonly newAuditMismatches: number;
}

export interface PromotionEngineRegistry {
  appendPromotionEvaluation(sample: PromotionEvaluationSample): boolean;
  listPromotionEvaluations(allocationId: string): readonly PromotionEvaluationSample[];
  getPageAllocation(input: { site: ApplicationSkillVersion["site"]; pageFingerprintHash: string }):
    SkillPageAllocation | undefined;
  getVersion(skillId: string, version: string): ApplicationSkillVersion | undefined;
  compareAndSetStatus(
    key: { skillId: string; site: ApplicationSkillVersion["site"]; pageFingerprintHash: string },
    expected: ApplicationSkillVersion["status"],
    next: ApplicationSkillVersion["status"],
    version: string
  ): boolean;
  retireChallenger(input: {
    skillId: string;
    site: ApplicationSkillVersion["site"];
    pageFingerprintHash: string;
    allocationId: string;
    championVersion: string;
    challengerVersion: string;
    retiredAt: string;
  }): boolean;
}

export type PromotionDecision =
  | { readonly kind: "continue"; readonly evaluationId: string }
  | { readonly kind: "promoted"; readonly evaluationId: string }
  | { readonly kind: "rolled_back"; readonly evaluationId: string }
  | { readonly kind: "stopped_inconclusive"; readonly evaluationId: string };

export class PromotionEngine {
  public constructor(private readonly dependencies: {
    readonly registry: PromotionEngineRegistry;
    readonly compare?: (input: StratifiedBootstrapInput) => StratifiedBootstrapResult;
  }) {}

  public async recordAndDecide(sample: PromotionEvaluationSample): Promise<PromotionDecision> {
    await Promise.resolve();
    const record = SkillExecutionRecordSchema.parse(sample.record);
    const evaluation = SkillEvaluationSchema.parse(sample.evaluation);
    if (evaluation.executionRecordId !== record.recordId
      || sample.requiredFieldCount !== record.counts.planned
      || sample.newAuditMismatches !== record.counts.auditMismatches) {
      throw new Error("skill_promotion_sample_invalid");
    }
    const registry = this.dependencies.registry;
    registry.appendPromotionEvaluation(sample);
    const evaluationId = sample.evaluation.evaluationId;
    if (sample.record.allocation !== "challenger") return { kind: "continue", evaluationId };

    const allocation = registry.getPageAllocation({
      site: sample.record.binding.site,
      pageFingerprintHash: sample.record.binding.pageFingerprintHash
    });
    if (allocation === undefined
      || allocation.allocationId !== sample.record.binding.allocationId
      || allocation.challengerVersion !== sample.record.binding.version) {
      return terminalDecision(registry.getVersion(sample.record.binding.skillId, sample.record.binding.version)?.status, evaluationId);
    }
    const key = {
      skillId: sample.record.binding.skillId,
      site: sample.record.binding.site,
      pageFingerprintHash: sample.record.binding.pageFingerprintHash
    };
    const status = registry.getVersion(key.skillId, sample.record.binding.version)?.status;
    if (status !== "challenger") return terminalDecision(status, evaluationId);

    if (sample.evaluation.safetyViolations > 0
      || sample.evaluation.incorrectWrites > 0
      || sample.newAuditMismatches > 0) {
      registry.compareAndSetStatus(key, "challenger", "quarantined", sample.record.binding.version);
      return terminalDecision(registry.getVersion(key.skillId, sample.record.binding.version)?.status, evaluationId);
    }

    const samples = registry.listPromotionEvaluations(allocation.allocationId);
    const comparisonInput = statisticsInput(allocation, samples, evaluation.evaluatorVersion);
    const comparison = (this.dependencies.compare ?? stratifiedBootstrapComparison)(comparisonInput);
    if (comparison.decision === "promote") {
      registry.compareAndSetStatus(key, "challenger", "champion", sample.record.binding.version);
    } else if (comparison.decision === "rollback") {
      registry.compareAndSetStatus(key, "challenger", "quarantined", sample.record.binding.version);
    } else if (comparison.decision === "stop-inconclusive") {
      registry.retireChallenger({
        ...key,
        allocationId: allocation.allocationId,
        championVersion: allocation.championVersion,
        challengerVersion: sample.record.binding.version,
        retiredAt: sample.evaluation.evaluatedAt
      });
    }
    return terminalDecision(registry.getVersion(key.skillId, sample.record.binding.version)?.status, evaluationId);
  }
}

function statisticsInput(
  allocation: SkillPageAllocation,
  samples: readonly PromotionEvaluationSample[],
  evaluatorVersion: string
): StratifiedBootstrapInput {
  const activatedAt = Date.parse(allocation.updatedAt);
  const projected = samples
    .filter((sample) => Date.parse(sample.evaluation.evaluatedAt) >= activatedAt
      && sample.evaluation.evaluatorVersion === evaluatorVersion)
    .map(projectSample);
  return {
    allocationId: allocation.allocationId,
    evaluatorVersion,
    champion: projected.filter((sample) => sample.cohort === "champion").map(({ cohort: _cohort, ...sample }) => sample),
    challenger: projected.filter((sample) => sample.cohort === "challenger").map(({ cohort: _cohort, ...sample }) => sample)
  };
}

function projectSample(sample: PromotionEvaluationSample): StratifiedEvaluationSample & { cohort: "champion" | "challenger" } {
  return {
    cohort: sample.record.allocation,
    executionId: sample.record.recordId,
    site: sample.record.binding.site,
    pageFingerprintHash: sample.record.binding.pageFingerprintHash,
    scenarioClass: sample.scenarioClass,
    requiredFieldCount: sample.requiredFieldCount,
    newAuditMismatches: sample.newAuditMismatches,
    evaluation: sample.evaluation
  };
}

function terminalDecision(status: ApplicationSkillVersion["status"] | undefined, evaluationId: string): PromotionDecision {
  if (status === "champion") return { kind: "promoted", evaluationId };
  if (status === "quarantined") return { kind: "rolled_back", evaluationId };
  if (status === "retired") return { kind: "stopped_inconclusive", evaluationId };
  return { kind: "continue", evaluationId };
}
