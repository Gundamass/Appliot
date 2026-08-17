import type { CertifiedHintPack, FormField, FormSnapshot, HintPackRepeatSection } from "@resume/contracts";
import { certifiedTextEquals, certifiedTextIncludes } from "./text-reference.js";

export function applyCertifiedHintPack(snapshot: FormSnapshot, pack: CertifiedHintPack): FormSnapshot {
  if (pack.lifecycleStatus !== "certified") return snapshot;
  return { ...snapshot, fields: snapshot.fields.map((field) => annotate(field, pack)) };
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
