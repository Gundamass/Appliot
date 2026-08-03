import {
  ProfileCompletenessSchema,
  type ProfileCompleteness,
  type ProfileFact
} from "@resume/contracts";
import {
  FIELD_DEFINITIONS,
  PROFILE_SECTION_DEFINITIONS,
  profileSectionFor,
  semanticLookupPaths,
  type FieldSection
} from "@resume/form-semantics";

const REVIEWED_STATUSES = new Set<ProfileFact["status"]>(["user_confirmed", "user_corrected"]);

export function calculateProfileCompleteness(facts: ProfileFact[]): ProfileCompleteness {
  const profileFacts = facts.filter((fact) => fact.scope === "profile" && fact.status !== "superseded");
  const sections = PROFILE_SECTION_DEFINITIONS.map((section) => {
    const definitions = FIELD_DEFINITIONS.filter((definition) =>
      definition.sections.includes(section.id) && definition.semantic.includes("[]") === section.repeatable
    );
    const entries = section.repeatable ? entryContexts(profileFacts, section.id) : [undefined];

    if (section.repeatable && entries.length === 0) {
      return { id: section.id, label: section.label, completed: 1, total: 1, missing: [] };
    }

    const missing: string[] = [];
    let completed = 0;
    for (const entry of entries) {
      for (const definition of definitions) {
        const fieldPath = materialize(definition.semantic, entry);
        if (fieldPath === undefined) continue;
        if (findReviewedFact(profileFacts, fieldPath) === undefined) missing.push(fieldPath);
        else completed += 1;
      }
    }
    return {
      id: section.id,
      label: section.label,
      completed,
      total: Math.max(completed + missing.length, 1),
      missing
    };
  });

  return ProfileCompletenessSchema.parse({
    completed: sections.reduce((sum, section) => sum + section.completed, 0),
    total: sections.reduce((sum, section) => sum + section.total, 0),
    sections
  });
}

function entryContexts(facts: ProfileFact[], section: FieldSection): string[] {
  const contexts = new Set<string>();
  for (const fact of facts) {
    if (profileSectionFor(fact.fieldPath) !== section) continue;
    const match = fact.fieldPath.match(/^([a-z]+\[\d+\])/u);
    if (match?.[1]) contexts.add(match[1]);
  }
  return [...contexts].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function findReviewedFact(facts: ProfileFact[], fieldPath: string): ProfileFact | undefined {
  const lookupPaths = new Set(semanticLookupPaths(fieldPath));
  return facts
    .filter((fact) => lookupPaths.has(fact.fieldPath) && REVIEWED_STATUSES.has(fact.status))
    .sort((left, right) => {
      const statusDifference = Number(right.status === "user_corrected") - Number(left.status === "user_corrected");
      if (statusDifference !== 0) return statusDifference;
      if (right.revision !== left.revision) return right.revision - left.revision;
      return left.id.localeCompare(right.id);
    })[0];
}

function materialize(template: string, entry: string | undefined): string | undefined {
  if (!template.includes("[]")) return template;
  if (!entry) return undefined;
  return template.replace(/^[a-z]+\[\]/u, entry);
}
