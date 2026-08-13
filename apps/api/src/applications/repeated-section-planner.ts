import type { FormSnapshot, ProfileFact } from "@resume/contracts";
import { classifyMokahrAddActions, type MokahrSection } from "@resume/form-semantics";

export interface RepeatedSectionPlan {
  section: MokahrSection;
  actionId: string;
  missingEntries: number;
}

export function planRepeatedSectionActions(
  snapshot: FormSnapshot,
  profileFacts: readonly ProfileFact[]
): RepeatedSectionPlan[] {
  const desired = new Map<MokahrSection, number>();
  for (const fact of profileFacts) {
    const match = fact.fieldPath.match(/^(education|work|projects|awards|campus)\[(\d+)\]/u);
    if (!match) continue;
    const section = match[1] === "campus" ? "laboratory" : match[1] as MokahrSection;
    desired.set(section, Math.max(desired.get(section) ?? 0, Number(match[2]) + 1));
  }

  const observed = new Map<MokahrSection, number>();
  for (const field of snapshot.fields) {
    const match = field.semanticHint?.match(/^(education|work|projects|awards|campus)\[(\d+)\]/u);
    if (!match) continue;
    const section = match[1] === "campus" ? "laboratory" : match[1] as MokahrSection;
    observed.set(section, Math.max(observed.get(section) ?? 0, Number(match[2]) + 1));
  }

  return classifyMokahrAddActions(snapshot.actions.map((action) => ({
    id: action.id,
    text: action.text,
    nearbyText: action.context ?? ""
  }))).flatMap((action) => {
    const missingEntries = Math.max(0, (desired.get(action.section) ?? 0) - (observed.get(action.section) ?? 0));
    return missingEntries > 0 ? [{ section: action.section, actionId: action.actionId, missingEntries }] : [];
  });
}
