import type { CertifiedHintPack, FormField, FormSnapshot, HintPackRepeatSection } from "@resume/contracts";

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
    if (rule.kind !== "add_repeated_entry" || !rule.verbs.some((verb) => normalize(action.text).includes(normalize(verb)))) {
      return [];
    }
    const context = normalize(`${action.context ?? ""} ${action.text}`);
    const section = pack.sectionRules.find((candidate) =>
      rule.sections.includes(candidate.section as HintPackRepeatSection)
      && candidate.headingAliases.some((alias) => context.includes(normalize(alias)))
    )?.section;
    if (section === undefined || !rule.sections.includes(section as HintPackRepeatSection)) return [];
    return [{ actionId: action.id, section: section as HintPackRepeatSection }];
  }));
}

function annotate(field: FormField, pack: CertifiedHintPack): FormField {
  const label = normalize(field.label);
  const rule = pack.fieldRules.find((candidate) => candidate.controlTypes.includes(field.type)
    && candidate.labelAliases.some((alias) => normalize(alias) === label)
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

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").trim().toLocaleLowerCase();
}
