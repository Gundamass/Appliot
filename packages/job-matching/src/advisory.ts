import { JobRequirementSchema, type JobRequirement } from "@resume/contracts";

export interface JobRequirementAdvisory {
  outcome: "satisfied" | "unknown";
  confidence: number;
  evidenceIds: string[];
}

export const UNKNOWN_ADVISORY: JobRequirementAdvisory = {
  outcome: "unknown",
  confidence: 0,
  evidenceIds: []
};

const RESPONSE_KEYS = ["confidence", "evidenceIds", "outcome"];

export function validateAdvisory(
  requirement: JobRequirement,
  top3EvidenceIds: readonly string[],
  response: unknown
): JobRequirementAdvisory {
  if (!JobRequirementSchema.safeParse(requirement).success) return { ...UNKNOWN_ADVISORY };
  if (!isPlainRecord(response)) return { ...UNKNOWN_ADVISORY };
  if (!sameKeys(Object.keys(response).sort(), RESPONSE_KEYS)) return { ...UNKNOWN_ADVISORY };
  if (response.outcome !== "satisfied" && response.outcome !== "unknown") return { ...UNKNOWN_ADVISORY };
  if (!Number.isFinite(response.confidence)
    || typeof response.confidence !== "number"
    || response.confidence < 0.9
    || response.confidence > 1) return { ...UNKNOWN_ADVISORY };
  if (!Array.isArray(response.evidenceIds)
    || response.evidenceIds.length > 3
    || response.evidenceIds.some((id) => typeof id !== "string" || id === "")
    || new Set(response.evidenceIds).size !== response.evidenceIds.length) return { ...UNKNOWN_ADVISORY };
  const allowed = new Set(top3EvidenceIds.slice(0, 3));
  if (response.evidenceIds.some((id) => !allowed.has(id))) return { ...UNKNOWN_ADVISORY };
  if (response.outcome === "satisfied" && response.evidenceIds.length === 0) return { ...UNKNOWN_ADVISORY };
  return {
    outcome: response.outcome,
    confidence: response.confidence,
    evidenceIds: [...response.evidenceIds]
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function sameKeys(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
