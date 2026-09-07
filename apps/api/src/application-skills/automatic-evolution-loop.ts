import type { ApplicationSkillVersion } from "@resume/contracts";
import {
  collectEvolutionOpportunities,
  type EvolutionOpportunity
} from "./evolution-collector.js";
import type {
  EvolutionQualificationInput,
  EvolutionQualificationResult
} from "./evolution-coordinator.js";
import type { PromotionEvaluationSample } from "./promotion-engine.js";
import type { SkillPageAllocation } from "./skill-selector.js";

export interface EvolutionQualificationPort {
  qualify(input: EvolutionQualificationInput): Promise<EvolutionQualificationResult>;
}

export interface AutomaticEvolutionRegistry {
  listPromotionEvaluations(allocationId: string): readonly PromotionEvaluationSample[];
  getPageAllocation(input: {
    site: ApplicationSkillVersion["site"];
    pageFingerprintHash: string;
  }): SkillPageAllocation | undefined;
  getVersion(skillId: string, version: string): ApplicationSkillVersion | undefined;
  activateChallenger(input: {
    skillId: string;
    site: ApplicationSkillVersion["site"];
    pageFingerprintHash: string;
    allocationId: string;
    championVersion: string;
    challengerVersion: string;
    challengerPermille: number;
    activatedAt: string;
  }): boolean;
}

export type AutomaticEvolutionDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "activated"; readonly opportunityId: string; readonly candidateVersion: string }
  | { readonly kind: "duplicate"; readonly opportunityId: string }
  | { readonly kind: "rejected"; readonly opportunityId?: string; readonly reason: string };

export class AutomaticEvolutionLoop {
  private readonly now: () => string;

  public constructor(private readonly dependencies: {
    readonly registry: AutomaticEvolutionRegistry;
    readonly qualifier: EvolutionQualificationPort;
    readonly now?: () => string;
  }) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async recordAndEvolve(sample: PromotionEvaluationSample): Promise<AutomaticEvolutionDecision> {
    const { record } = sample;
    if (record.allocation !== "champion") return { kind: "continue" };
    const registry = this.dependencies.registry;
    const allocation = registry.getPageAllocation({
      site: record.binding.site,
      pageFingerprintHash: record.binding.pageFingerprintHash
    });
    if (allocation === undefined
      || allocation.allocationId !== record.binding.allocationId
      || allocation.championVersion !== record.binding.version
      || allocation.challengerVersion !== undefined
      || allocation.challengerPercent !== 0) {
      return { kind: "continue" };
    }
    const parent = registry.getVersion(record.binding.skillId, record.binding.version);
    if (parent?.status !== "champion") return { kind: "continue" };

    const samples = registry.listPromotionEvaluations(allocation.allocationId);
    const opportunities = collectEvolutionOpportunities({
      scope: {
        site: record.binding.site,
        pageFingerprintHash: record.binding.pageFingerprintHash,
        skillId: record.binding.skillId,
        version: record.binding.version
      },
      executionRecords: samples.map(({ record: execution }) => execution),
      evaluations: samples.map(({ evaluation }) => evaluation),
      fingerprintObservations: [],
      openOpportunityIds: []
    });
    const opportunity = opportunities[0];
    if (opportunity === undefined) return { kind: "continue" };
    return this.qualifyAndActivate(opportunity, parent, allocation);
  }

  private async qualifyAndActivate(
    opportunity: EvolutionOpportunity,
    parent: ApplicationSkillVersion,
    allocation: SkillPageAllocation
  ): Promise<AutomaticEvolutionDecision> {
    const timestamp = this.now();
    let result: EvolutionQualificationResult;
    try {
      result = await this.dependencies.qualifier.qualify({
        opportunity,
        parent,
        candidateVersion: nextPatchVersion(parent.version),
        cutoffAt: timestamp,
        createdAt: timestamp,
        binding: {
          skillId: parent.skillId,
          version: nextPatchVersion(parent.version),
          site: parent.site,
          pageFingerprintHash: allocation.pageFingerprintHash,
          allocationId: allocation.allocationId
        }
      });
    } catch {
      return { kind: "rejected", opportunityId: opportunity.opportunityId, reason: "qualification_failed" };
    }
    if (result.kind === "duplicate") return { kind: "duplicate", opportunityId: opportunity.opportunityId };
    if (result.kind === "rejected") {
      return { kind: "rejected", opportunityId: opportunity.opportunityId, reason: result.reason };
    }
    const activated = this.dependencies.registry.activateChallenger({
      skillId: parent.skillId,
      site: parent.site,
      pageFingerprintHash: allocation.pageFingerprintHash,
      allocationId: allocation.allocationId,
      championVersion: parent.version,
      challengerVersion: result.candidate.version,
      challengerPermille: 100,
      activatedAt: timestamp
    });
    return activated
      ? { kind: "activated", opportunityId: opportunity.opportunityId, candidateVersion: result.candidate.version }
      : { kind: "rejected", opportunityId: opportunity.opportunityId, reason: "activation_conflict" };
  }
}

function nextPatchVersion(version: string): string {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (parts === null) throw new Error("skill_version_invalid");
  return `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`;
}
