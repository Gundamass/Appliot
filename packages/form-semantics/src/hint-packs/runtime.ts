import type { CertifiedHintPack, FormField, FormSnapshot, HintPackRepeatSection } from "@resume/contracts";
import { certifiedTextEquals, certifiedTextIncludes } from "./text-reference.js";

export function applyCertifiedHintPack(snapshot: FormSnapshot, pack: CertifiedHintPack): FormSnapshot {
  if (pack.lifecycleStatus !== "certified") return snapshot;
  const annotated = snapshot.fields.map((field) => annotate(field, pack));
  return { ...snapshot, fields: orderFields(annotated, pack) };
}

export function classifyRepeatedActions(
  snapshot: FormSnapshot,
  pack: CertifiedHintPack
): Array<{ actionId: string; section: HintPackRepeatSection }> {
  if (pack.lifecycleStatus !== "certified") return [];
  return snapshot.actions.flatMap((action) => pack.actionRules.flatMap((rule) => {
    if (rule.kind !== "add_repeated_entry" || !rule.verbs.some((verb) => certifiedTextIncludes(action.text, verb))) {
      return [];
    }
    const context = `${action.context ?? ""} ${action.text}`;
    const section = pack.sectionRules.find((candidate) =>
      rule.sections.includes(candidate.section as HintPackRepeatSection)
      && candidate.headingAliases.some((alias) => certifiedTextIncludes(context, alias))
    )?.section;
    if (section === undefined || !rule.sections.includes(section as HintPackRepeatSection)) return [];
    return [{ actionId: action.id, section: section as HintPackRepeatSection }];
  }));
}

function annotate(field: FormField, pack: CertifiedHintPack): FormField {
  const rule = pack.fieldRules.find((candidate) => candidate.controlTypes.includes(field.type)
    && candidate.labelAliases.some((alias) => certifiedTextEquals(field.label, alias))
    && (candidate.sections.length === 0
      || field.sectionHint === undefined
      || candidate.sections.includes(field.sectionHint)));
  return rule === undefined ? field : {
    ...field,
    semanticHint: rule.profilePath,
    semanticSource: "certified_hint",
    semanticProvenance: {
      packId: pack.packId,
      packVersion: pack.version,
      confidence: rule.confidence,
      certification: "certified"
    }
  };
}

function orderFields(fields: FormField[], pack: CertifiedHintPack): FormField[] {
  const ordered = [...fields];
  for (const rule of pack.sectionRules) {
    if (rule.fieldOrderAliases.length === 0) continue;
    const sectionHint = rule.section === "laboratory" ? "campus" : rule.section;
    const positions = fields.flatMap((field, index) => field.sectionHint === sectionHint ? [index] : []);
    const ranked = positions.map((position, index) => ({ field: fields[position]!, index }))
      .sort((left, right) => {
        const rankDifference = fieldRank(rule.fieldOrderAliases, left.field.label)
          - fieldRank(rule.fieldOrderAliases, right.field.label);
        return rankDifference || left.index - right.index;
      });
    positions.forEach((position, index) => {
      ordered[position] = ranked[index]!.field;
    });
  }
  return ordered;
}

function fieldRank(fieldOrderAliases: readonly (readonly string[])[], label: string): number {
  const index = fieldOrderAliases.findIndex((aliases) =>
    aliases.some((alias) => certifiedTextIncludes(label, alias))
  );
  return index < 0 ? fieldOrderAliases.length : index;
}
