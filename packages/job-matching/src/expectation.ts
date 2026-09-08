import type {
  JobExpectationCriterion,
  JobExpectationSnapshot,
  ProfileFact
} from "@resume/contracts";

export const JOB_EXPECTATION_FIELDS = [
  { canonicalPath: "preferences.targetRole", kind: "target_role", label: "目标岗位", legacyPaths: [] },
  { canonicalPath: "preferences.targetCity", kind: "location", label: "地点", legacyPaths: ["preferences.location"] },
  { canonicalPath: "preferences.employmentType", kind: "employment_type", label: "用工类型", legacyPaths: [] },
  { canonicalPath: "preferences.industry", kind: "industry", label: "行业", legacyPaths: [] },
  { canonicalPath: "preferences.workMode", kind: "work_mode", label: "办公方式", legacyPaths: [] },
  { canonicalPath: "preferences.salary", kind: "salary", label: "薪资", legacyPaths: [] }
] as const;

type JobExpectationField = typeof JOB_EXPECTATION_FIELDS[number];

export interface ProjectedJobExpectation {
  canonicalPath: JobExpectationField["canonicalPath"];
  fieldPath: string;
  kind: JobExpectationCriterion["kind"];
  label: string;
  values: string[];
  factId: string;
  status: ProfileFact["status"];
  needsConfirmation: boolean;
}

interface Candidate {
  fact: ProfileFact;
  values: string[];
}

export function projectJobExpectations(facts: readonly ProfileFact[]): ProjectedJobExpectation[] {
  return JOB_EXPECTATION_FIELDS.flatMap((field) => {
    const paths: readonly string[] = [field.canonicalPath, ...field.legacyPaths];
    const candidate = facts
      .filter((fact) => fact.scope === "profile" && fact.status !== "superseded" && paths.includes(fact.fieldPath))
      .map((fact): Candidate => ({ fact, values: expectationValues(fact.value) }))
      .filter(({ values }) => values.length > 0)
      .sort((left, right) => compareCandidates(left.fact, right.fact, field))[0];
    if (candidate === undefined) return [];
    return [{
      canonicalPath: field.canonicalPath,
      fieldPath: candidate.fact.fieldPath,
      kind: field.kind,
      label: field.label,
      values: candidate.values,
      factId: candidate.fact.id,
      status: candidate.fact.status,
      needsConfirmation: candidate.fact.status === "extracted"
    }];
  });
}

export function jobExpectationSnapshot(
  facts: readonly ProfileFact[],
  revision: number,
  confirmedAt: string
): JobExpectationSnapshot {
  return {
    revision,
    confirmedAt,
    criteria: projectJobExpectations(facts)
      .filter((expectation) => isReviewed(expectation.status))
      .map(({ kind, values }) => ({ kind, values, strength: "required" }))
  };
}

export function isUnrestrictedLocationValue(value: string): boolean {
  return new Set(["全国", "不限", "不限地区", "不限地点", "全国范围"]).has(
    value.normalize("NFKC").trim().replace(/\s+/g, "")
  );
}

export function hasUsableJobExpectation(facts: readonly ProfileFact[]): boolean {
  return projectJobExpectations(facts).some((expectation) => isReviewed(expectation.status));
}

function compareCandidates(left: ProfileFact, right: ProfileFact, field: JobExpectationField): number {
  return Number(isReviewed(right.status)) - Number(isReviewed(left.status))
    || Number(right.fieldPath === field.canonicalPath) - Number(left.fieldPath === field.canonicalPath)
    || right.revision - left.revision
    || left.id.localeCompare(right.id);
}

function isReviewed(status: ProfileFact["status"]): boolean {
  return status === "user_confirmed" || status === "user_corrected";
}

function expectationValues(value: ProfileFact["value"]): string[] {
  const values = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  const normalized = values.map((item) => item.trim()).filter((item) => item.length > 0);
  return [...new Set(normalized)];
}
