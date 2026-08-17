import {
  HintPackDefinitionSchema,
  type HintPackDefinition,
  type ReplayAssertion
} from "@resume/contracts";
import { FIELD_DEFINITIONS, type FieldDefinition } from "@resume/form-semantics";

const ALLOWED_ACTION_KINDS = new Set(["add_repeated_entry", "intermediate_save", "intermediate_navigation"]);

export function validateHintPackCandidate(input: unknown): ReplayAssertion[] {
  const parsed = HintPackDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return [assertion("schema_valid", false, "candidate does not match HintPackDefinitionSchema")];
  }

  const definition = parsed.data;
  const assertions: ReplayAssertion[] = [
    assertion("schema_valid", true, "candidate matches HintPackDefinitionSchema"),
    assertion(
      "policy_safe",
      definition.fieldRules.length + definition.actionRules.length > 0
        && definition.actionRules.every((rule) => ALLOWED_ACTION_KINDS.has(rule.kind)),
      "candidate contains declarative rules and no terminal or unknown actions"
    ),
    assertion(
      "mapping_one_to_one",
      hasOneToOneMappings(definition),
      "each profile path and observed label alias maps to at most one field rule"
    )
  ];

  for (const rule of definition.fieldRules) {
    const ontology = ontologyFor(rule.profilePath);
    assertions.push(assertion(
      "control_type_compatible",
      ontology !== undefined && rule.controlTypes.every((type) => ontology.types.includes(type)),
      `${rule.ruleId} control types match the known profile ontology`
    ));
    assertions.push(assertion(
      "section_compatible",
      ontology !== undefined && (rule.sections.length === 0
        || rule.sections.every((section) => ontology.sections.includes(normalizeSection(section)))),
      `${rule.ruleId} sections match the known profile ontology`
    ));
  }
  return assertions;
}

function assertion(code: ReplayAssertion["code"], passed: boolean, detail: string): ReplayAssertion {
  return { code, passed, detail };
}

function hasOneToOneMappings(definition: HintPackDefinition): boolean {
  const paths = new Set<string>();
  const aliases = new Set<string>();
  for (const rule of definition.fieldRules) {
    if (paths.has(rule.profilePath)) return false;
    paths.add(rule.profilePath);
    for (const alias of rule.labelAliases) {
      const normalized = alias.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
      if (aliases.has(normalized)) return false;
      aliases.add(normalized);
    }
  }
  return true;
}

function ontologyFor(profilePath: string): FieldDefinition | undefined {
  return FIELD_DEFINITIONS.find((definition) => matchesSemanticPath(definition.semantic, profilePath));
}

function matchesSemanticPath(template: string, profilePath: string): boolean {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace("\\[\\]", "\\[\\d+\\]");
  return new RegExp(`^${escaped}$`, "u").test(profilePath);
}

function normalizeSection(section: string): FieldDefinition["sections"][number] {
  switch (section) {
    case "internship":
    case "work_combined":
      return "work";
    default:
      return section as FieldDefinition["sections"][number];
  }
}
