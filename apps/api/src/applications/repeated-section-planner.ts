import type { FormSnapshot, ProfileFact } from "@resume/contracts";
import { classifyMokahrAddActions, type MokahrSection } from "@resume/form-semantics";
import { compatibleExperienceIndexes, type ExperienceSection } from "./experience-routing.js";

export interface RepeatedSectionPlan {
  section: MokahrSection;
  actionId: string;
  missingEntries: number;
  profileIndexes: number[];
}

export function planRepeatedSectionActions(
  snapshot: FormSnapshot,
  profileFacts: readonly ProfileFact[]
): RepeatedSectionPlan[] {
  return classifyMokahrAddActions(snapshot.actions.map((action) => ({
    id: action.id,
    text: action.text,
    nearbyText: action.context ?? ""
  }))).flatMap((action) => {
    const profileIndexes = profileIndexesForSection(profileFacts, action.section);
    const observedEntries = observedEntryCount(snapshot, action.section);
    const missingEntries = Math.max(0, profileIndexes.length - observedEntries);
    return missingEntries > 0
      ? [{ section: action.section, actionId: action.actionId, missingEntries, profileIndexes }]
      : [];
  });
}

function profileIndexesForSection(facts: readonly ProfileFact[], section: MokahrSection): number[] {
  if (isExperienceSection(section)) return compatibleExperienceIndexes(facts, section);
  const root = section === "laboratory" ? "campus" : section;
  const indexes = new Set<number>();
  for (const fact of facts) {
    if (fact.scope !== "profile" || fact.status === "superseded") continue;
    const match = fact.fieldPath.match(new RegExp(`^${root}\\[(\\d+)\\]`, "u"));
    if (match) indexes.add(Number(match[1]));
  }
  return [...indexes].sort((left, right) => left - right);
}

function observedEntryCount(snapshot: FormSnapshot, section: MokahrSection): number {
  const root = section === "laboratory" ? "campus" : isExperienceSection(section) ? "work" : section;
  const indexes = new Set<number>();
  for (const field of snapshot.fields) {
    if (isExperienceSection(section)
      && section !== "work_combined"
      && field.sectionHint !== section) continue;
    const match = field.semanticHint?.match(new RegExp(`^${root}\\[(\\d+)\\]`, "u"));
    if (match) indexes.add(Number(match[1]));
  }
  return indexes.size;
}

function isExperienceSection(section: MokahrSection): section is ExperienceSection {
  return section === "work" || section === "internship" || section === "work_combined";
}
