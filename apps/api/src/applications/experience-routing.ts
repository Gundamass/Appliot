import type { ProfileFact } from "@resume/contracts";

export type ExperienceKind = "work" | "internship" | "unknown";
export type ExperienceSection = "work" | "internship" | "work_combined";

const INTERNSHIP = /\u5b9e\u4e60|intern(?:ship)?/iu;
const FORMAL = /\u6b63\u5f0f|\u5168\u804c|full[ -]?time/iu;

export function classifyEmploymentType(value: unknown): ExperienceKind {
  if (typeof value !== "string") return "unknown";
  const normalized = value.normalize("NFKC").trim();
  if (INTERNSHIP.test(normalized)) return "internship";
  if (FORMAL.test(normalized)) return "work";
  return "unknown";
}

export function compatibleExperienceIndexes(
  facts: readonly ProfileFact[],
  section: ExperienceSection
): number[] {
  const latestByPath = new Map<string, ProfileFact>();
  for (const fact of facts) {
    if (fact.scope !== "profile" || !/^work\[\d+\]\.employmentType$/u.test(fact.fieldPath)) continue;
    const current = latestByPath.get(fact.fieldPath);
    if (current === undefined || fact.revision > current.revision) latestByPath.set(fact.fieldPath, fact);
  }

  return [...latestByPath.values()].flatMap((fact) => {
    if (fact.status !== "user_confirmed" && fact.status !== "user_corrected") return [];
    const kind = classifyEmploymentType(fact.value);
    if (kind === "unknown" || (section !== "work_combined" && kind !== section)) return [];
    const match = fact.fieldPath.match(/^work\[(\d+)\]/u);
    return match ? [Number(match[1])] : [];
  }).sort((left, right) => left - right);
}
