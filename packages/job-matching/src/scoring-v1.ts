import type {
  JobExpectationSnapshot,
  JobMatchResult,
  JobMatchScoreBreakdown,
  JobPosting,
  JobRequirement,
  MatchEvidence,
  RequirementAssessment
} from "@resume/contracts";
import { isUnrestrictedLocationValue } from "./expectation.js";

export const JOB_MATCH_V1_DIMENSION_WEIGHTS = {
  skill: 35,
  responsibility: 25,
  project: 20,
  qualification: 10,
  preference: 10
} as const;

export const JOB_MATCH_V1_EVIDENCE_QUALITIES = {
  confirmed_fact: 1,
  normalized_fact: 0.8,
  trigram: 0.6,
  dense: 0.6
} as const;

type ScoringDimension = keyof typeof JOB_MATCH_V1_DIMENSION_WEIGHTS;

const SCORING_DIMENSION_LABELS: Record<ScoringDimension, string> = {
  skill: "技能",
  responsibility: "工作职责",
  project: "项目经验",
  qualification: "基本条件",
  preference: "求职偏好"
};

export interface ScoringEvidence {
  requirementId: string;
  evidenceId: string;
  source: keyof typeof JOB_MATCH_V1_EVIDENCE_QUALITIES;
  relation: "supports" | "contradicts" | "related";
  summary: string;
}

export interface JobMatchScoringInput {
  sessionId: string;
  posting: JobPosting;
  expectation: JobExpectationSnapshot;
  profileRevision: number;
  evidence: readonly ScoringEvidence[];
}

export type JobMatchResultDraft = Omit<JobMatchResult, "id" | "version" | "stale"> & {
  canonicalUrl: string;
  hasConflict: boolean;
};

const EXPECTATION_KIND_BY_CATEGORY: Partial<Record<JobRequirement["category"],
  JobExpectationSnapshot["criteria"][number]["kind"]>> = {
  location: "location",
  employment_type: "employment_type",
  industry: "industry",
  work_mode: "work_mode",
  salary: "salary"
};

export function assessRequirement(
  requirement: JobRequirement,
  evidence: readonly ScoringEvidence[],
  expectation: JobExpectationSnapshot
): RequirementAssessment {
  const relevantEvidence = evidence.filter((item) => item.requirementId === requirement.id);
  const expectationAssessment = assessExpectation(requirement, expectation);

  if (expectationAssessment === "conflict") {
    return assessment(requirement.id, "conflict", "required_expectation_mismatch");
  }
  if (requirement.required && relevantEvidence.some((item) =>
    item.source === "confirmed_fact" && item.relation === "contradicts"
  )) {
    return assessment(requirement.id, "conflict", "confirmed_fact_mismatch");
  }
  if (expectationAssessment === "satisfied") {
    return assessment(requirement.id, "satisfied", "expectation_match");
  }
  if (relevantEvidence.some((item) => item.relation === "supports")) {
    return assessment(requirement.id, "satisfied", "profile_evidence_match");
  }
  return assessment(requirement.id, "unknown", "insufficient_confirmed_evidence");
}

export function scoreJobMatch(input: JobMatchScoringInput): JobMatchResultDraft {
  const outcomes = input.posting.requirements.map((requirement) =>
    assessRequirement(requirement, input.evidence, input.expectation)
  );
  const outcomeByRequirement = new Map(outcomes.map((item) => [item.requirementId, item]));
  const requirementWeights = calculateRequirementWeights(input.posting.requirements);
  let knownCoverage = 0;
  let evidenceQuality = 0;

  for (const requirement of input.posting.requirements) {
    const weight = requirementWeights.get(requirement.id) ?? 0;
    const outcome = outcomeByRequirement.get(requirement.id)?.outcome ?? "unknown";
    if (outcome !== "unknown") knownCoverage += weight;
    evidenceQuality += weight * bestEvidenceQuality(requirement.id, input.evidence);
  }

  const scoreBreakdown = buildScoreBreakdown(
    input.posting.requirements,
    requirementWeights,
    outcomeByRequirement
  );
  const fitScore = scoreBreakdown.total;
  const confidence = round2(100 * (0.7 * knownCoverage + 0.3 * evidenceQuality));
  const rankingScore = round2(fitScore * (0.75 + 0.25 * confidence / 100));
  const storedEvidence = toStoredEvidence(input.evidence, input.posting.requirements);
  const gaps = input.posting.requirements.flatMap((requirement) => {
    const outcome = outcomeByRequirement.get(requirement.id)?.outcome ?? "unknown";
    return outcome === "satisfied" ? [] : [{
      requirementId: requirement.id,
      outcome,
      summary: requirement.sourceEvidence
    }];
  });

  return {
    sessionId: input.sessionId,
    postingId: input.posting.id,
    canonicalUrl: input.posting.canonicalUrl,
    fitScore,
    confidence,
    rankingScore,
    scoreBreakdown,
    outcomes,
    evidence: storedEvidence,
    gaps,
    scoringVersion: "job-match-v1",
    profileRevision: input.profileRevision,
    expectationRevision: input.expectation.revision,
    postingContentHash: input.posting.contentHash,
    hasConflict: outcomes.some((item) => item.outcome === "conflict")
  };
}

export function sortJobMatches<T extends Pick<JobMatchResultDraft,
  "rankingScore" | "fitScore" | "confidence" | "canonicalUrl">>(results: readonly T[]): T[] {
  return [...results].sort((left, right) =>
    right.fitScore - left.fitScore
    || right.confidence - left.confidence
    || compareText(left.canonicalUrl, right.canonicalUrl)
  );
}

function assessExpectation(
  requirement: JobRequirement,
  expectation: JobExpectationSnapshot
): "satisfied" | "conflict" | "unknown" {
  const kind = EXPECTATION_KIND_BY_CATEGORY[requirement.category];
  if (kind === undefined) return "unknown";
  const criteria = expectation.criteria.filter((criterion) => criterion.kind === kind);
  if (criteria.length === 0) return "unknown";
  if (kind === "location" && criteria.some((criterion) => criterion.values.some(isUnrestrictedLocationValue))) {
    return "satisfied";
  }
  const requirementValue = normalizeComparable(requirement.normalizedValue);
  if (requirementValue === "") return "unknown";
  const matches = criteria.some((criterion) =>
    criterion.values.some((value) => normalizeComparable(value) === requirementValue)
  );
  if (matches) return "satisfied";
  if (kind === "salary") return "unknown";
  return criteria.some((criterion) => criterion.strength === "required") ? "conflict" : "unknown";
}

function assessment(
  requirementId: string,
  outcome: RequirementAssessment["outcome"],
  reasonCode: string
): RequirementAssessment {
  return { requirementId, outcome, reasonCode };
}

function calculateRequirementWeights(requirements: readonly JobRequirement[]): Map<string, number> {
  const grouped = new Map<ScoringDimension, JobRequirement[]>();
  for (const requirement of requirements) {
    const dimension = scoringDimension(requirement.category);
    if (dimension === undefined) continue;
    const existing = grouped.get(dimension);
    if (existing === undefined) grouped.set(dimension, [requirement]);
    else existing.push(requirement);
  }
  const presentWeight = [...grouped.keys()].reduce(
    (total, dimension) => total + JOB_MATCH_V1_DIMENSION_WEIGHTS[dimension],
    0
  );
  const weights = new Map<string, number>();
  if (presentWeight === 0) return weights;
  for (const [dimension, dimensionRequirements] of grouped) {
    const requirementWeight = JOB_MATCH_V1_DIMENSION_WEIGHTS[dimension]
      / presentWeight
      / dimensionRequirements.length;
    for (const requirement of dimensionRequirements) weights.set(requirement.id, requirementWeight);
  }
  return weights;
}

function buildScoreBreakdown(
  requirements: readonly JobRequirement[],
  requirementWeights: ReadonlyMap<string, number>,
  outcomeByRequirement: ReadonlyMap<string, RequirementAssessment>
): JobMatchScoreBreakdown {
  const rawDimensions = Object.keys(JOB_MATCH_V1_DIMENSION_WEIGHTS).flatMap((dimensionKey) => {
    const dimension = dimensionKey as ScoringDimension;
    const dimensionRequirements = requirements.filter((requirement) =>
      scoringDimension(requirement.category) === dimension
    );
    if (dimensionRequirements.length === 0) return [];

    let available = 0;
    let earned = 0;
    let satisfied = 0;
    let unknown = 0;
    let conflict = 0;
    for (const requirement of dimensionRequirements) {
      const weight = 100 * (requirementWeights.get(requirement.id) ?? 0);
      const outcome = outcomeByRequirement.get(requirement.id)?.outcome ?? "unknown";
      available += weight;
      earned += weight * (outcome === "satisfied" ? 1 : 0);
      if (outcome === "satisfied") satisfied += 1;
      else if (outcome === "conflict") conflict += 1;
      else unknown += 1;
    }

    return [{ dimension, available, earned, satisfied, unknown, conflict }];
  });
  const total = round2(rawDimensions.reduce((sum, dimension) => sum + dimension.earned, 0));
  const availableTotal = round2(rawDimensions.reduce((sum, dimension) => sum + dimension.available, 0));
  const roundedEarned = roundComponents(rawDimensions.map((dimension) => dimension.earned), total);
  const roundedAvailable = roundComponents(
    rawDimensions.map((dimension) => dimension.available),
    availableTotal
  );

  return {
    total,
    dimensions: rawDimensions.map((dimension, index) => ({
      dimension: dimension.dimension,
      label: SCORING_DIMENSION_LABELS[dimension.dimension],
      earned: roundedEarned[index] ?? 0,
      available: roundedAvailable[index] ?? 0,
      satisfied: dimension.satisfied,
      unknown: dimension.unknown,
      conflict: dimension.conflict
    }))
  };
}

function roundComponents(values: readonly number[], targetTotal: number): number[] {
  const rounded = values.map(round2);
  const adjustment = round2(targetTotal - rounded.reduce((sum, value) => sum + value, 0));
  if (adjustment === 0) return rounded;
  const adjustmentIndex = values.findLastIndex((value) => value > 0);
  if (adjustmentIndex >= 0) {
    rounded[adjustmentIndex] = round2((rounded[adjustmentIndex] ?? 0) + adjustment);
  }
  return rounded;
}

function scoringDimension(category: JobRequirement["category"]): ScoringDimension | undefined {
  if (category === "skill") return "skill";
  if (category === "responsibility") return "responsibility";
  if (category === "project") return "project";
  if (category === "education" || category === "major" || category === "experience_years") {
    return "qualification";
  }
  if (["location", "employment_type", "industry", "work_mode", "salary"].includes(category)) {
    return "preference";
  }
  return undefined;
}

function bestEvidenceQuality(requirementId: string, evidence: readonly ScoringEvidence[]): number {
  let best = 0;
  for (const item of evidence) {
    if (item.requirementId !== requirementId) continue;
    best = Math.max(best, JOB_MATCH_V1_EVIDENCE_QUALITIES[item.source]);
  }
  return best;
}

function toStoredEvidence(
  evidence: readonly ScoringEvidence[],
  requirements: readonly JobRequirement[]
): MatchEvidence[] {
  const requirementIds = new Set(requirements.map((item) => item.id));
  return evidence
    .filter((item) => requirementIds.has(item.requirementId))
    .map((item) => ({
      requirementId: item.requirementId,
      evidenceId: item.evidenceId,
      source: item.source,
      quality: JOB_MATCH_V1_EVIDENCE_QUALITIES[item.source],
      summary: item.summary
    }));
}

function normalizeComparable(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
