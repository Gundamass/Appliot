import { createHash } from "node:crypto";
import {
  ApplicationFieldSemanticSchema,
  ApplicationSkillCapabilitySchema,
  ApplicationSkillVersionSchema,
  SkillDirectiveSchema,
  type ApplicationFieldSemantic,
  type ApplicationSkillCapability,
  type ApplicationSkillVersion,
  type SkillCondition,
  type SkillDirective
} from "@resume/contracts";

export interface NormalizedSkillPageObservation {
  readonly origin: string;
  readonly route: string;
  readonly landmarks: readonly string[];
  readonly fields: ReadonlyArray<{
    readonly semantic: ApplicationFieldSemantic;
    readonly empty: boolean;
  }>;
  readonly availableCapabilities: readonly ApplicationSkillCapability[];
  readonly challengePresent: boolean;
}

export type PageMatch =
  | { readonly kind: "matched"; readonly pageVariantId: string; readonly fingerprintHash: string }
  | { readonly kind: "ambiguous"; readonly candidateIds: string[] }
  | { readonly kind: "unmatched"; readonly reason: "origin" | "fingerprint" };

interface MatchContext {
  readonly observation: NormalizedSkillPageObservation;
  readonly skill: ApplicationSkillVersion;
  readonly pageVariantId: string;
}

interface ScoredVariant {
  readonly id: string;
  readonly score: number;
  readonly index: number;
}

const MATCH_THRESHOLD = 0.75;
const LEAD_MARGIN = 0.15;

export class SkillInterpreter {
  private readonly matches = new WeakMap<object, MatchContext>();

  public matchPage(observationInput: unknown, skillInput: unknown): PageMatch {
    const observation = normalizeObservation(observationInput);
    if (observation === undefined) return { kind: "unmatched", reason: "origin" };

    const parsedSkill = ApplicationSkillVersionSchema.safeParse(skillInput);
    if (!parsedSkill.success) return { kind: "unmatched", reason: "fingerprint" };
    const skill = parsedSkill.data;
    if (!originAllowed(observation.origin, skill.allowedDomains)) {
      return { kind: "unmatched", reason: "origin" };
    }

    const scores = skill.content.pageVariants
      .map((variant, index): ScoredVariant => ({
        id: variant.id,
        score: variantScore(observation, variant.match),
        index
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const first = scores[0];
    if (first === undefined || first.score < MATCH_THRESHOLD) {
      return { kind: "unmatched", reason: "fingerprint" };
    }
    const second = scores[1];
    if (second !== undefined && first.score - second.score < LEAD_MARGIN) {
      return {
        kind: "ambiguous",
        candidateIds: scores
          .filter((candidate) => first.score - candidate.score < LEAD_MARGIN)
          .map((candidate) => candidate.id)
      };
    }

    const match: PageMatch = Object.freeze({
      kind: "matched",
      pageVariantId: first.id,
      fingerprintHash: fingerprint(observation, skill.pageFingerprintRule.ruleHash)
    });
    this.matches.set(match, { observation, skill, pageVariantId: first.id });
    return match;
  }

  public compileDirectives(
    match: PageMatch,
    requestedFields: readonly ApplicationFieldSemantic[]
  ): SkillDirective[] {
    if (match.kind !== "matched" || typeof match !== "object" || match === null) return [];
    const context = this.matches.get(match);
    if (context === undefined) return [];

    const requested = uniqueRequestedFields(requestedFields);
    const directives: SkillDirective[] = [];
    const resolved = new Set<ApplicationFieldSemantic>();
    const verified = new Set<ApplicationFieldSemantic>();
    const observed = new Set(context.observation.fields.map((field) => field.semantic));
    const fields = new Map(context.skill.content.fields.map((field) => [field.semantic, field]));
    const workflow = new Map(context.skill.content.workflow.map((step) => [step.id, step]));
    const variant = context.skill.content.pageVariants.find((candidate) => candidate.id === context.pageVariantId);
    if (variant === undefined) return [];

    let stepId: string | undefined = variant.workflowEntry;
    const visited = new Set<string>();
    while (stepId !== undefined && !visited.has(stepId) && visited.size < context.skill.content.workflow.length) {
      visited.add(stepId);
      const step = workflow.get(stepId);
      if (step === undefined) break;
      if (step.when === undefined || conditionMatches(step.when, context)) {
        for (const action of step.actions) {
          if (
            action.capability === "fill_empty_fields"
            || action.capability === "select_option"
            || action.capability === "upload_approved_file"
          ) {
            const semantics = action.capability === "upload_approved_file" ? [action.semantic] : action.semantics;
            for (const semantic of requested) {
              if (!semantics.includes(semantic) || resolved.has(semantic) || !observed.has(semantic)) continue;
              const field = fields.get(semantic);
              if (field === undefined) continue;
              pushDirective(directives, {
                kind: "resolve-field",
                semantic,
                locatorKeys: [...new Set(field.locatorHints.map((hint) => hint.key))]
              });
              resolved.add(semantic);
            }
          } else if (action.capability === "readback") {
            for (const semantic of requested) {
              if (!action.semantics.includes(semantic) || verified.has(semantic) || !observed.has(semantic)) continue;
              pushDirective(directives, { kind: "verify-field", semantic });
              verified.add(semantic);
            }
          }
        }
      }
      stepId = step.next === "continue_or_wait" ? undefined : step.next;
    }

    const recoveryLimit = Math.min(context.skill.content.recovery.maxRetries, 3);
    const recoveryActions = [...new Set(context.skill.content.recovery.actions)].slice(0, recoveryLimit);
    recoveryActions.forEach((action) => pushDirective(directives, { kind: "recover", action }));
    return directives;
  }
}

function normalizeObservation(input: unknown): NormalizedSkillPageObservation | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (
    typeof value.origin !== "string"
    || typeof value.route !== "string"
    || !value.route.startsWith("/")
    || !Array.isArray(value.landmarks)
    || !value.landmarks.every((landmark) => typeof landmark === "string")
    || !Array.isArray(value.fields)
    || !Array.isArray(value.availableCapabilities)
    || typeof value.challengePresent !== "boolean"
  ) return undefined;

  let origin: URL;
  try {
    origin = new URL(value.origin);
  } catch {
    return undefined;
  }
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    return undefined;
  }

  const fields: Array<NormalizedSkillPageObservation["fields"][number]> = [];
  for (const fieldInput of value.fields) {
    if (typeof fieldInput !== "object" || fieldInput === null || Array.isArray(fieldInput)) return undefined;
    const field = fieldInput as Record<string, unknown>;
    const semantic = ApplicationFieldSemanticSchema.safeParse(field.semantic);
    if (!semantic.success || typeof field.empty !== "boolean") return undefined;
    fields.push({ semantic: semantic.data, empty: field.empty });
  }
  const availableCapabilities: ApplicationSkillCapability[] = [];
  for (const capabilityInput of value.availableCapabilities) {
    const capability = ApplicationSkillCapabilitySchema.safeParse(capabilityInput);
    if (!capability.success) return undefined;
    availableCapabilities.push(capability.data);
  }
  return {
    origin: origin.origin,
    route: normalizeRoute(value.route),
    landmarks: value.landmarks.map(normalizeText),
    fields,
    availableCapabilities,
    challengePresent: value.challengePresent
  };
}

function originAllowed(originValue: string, allowedDomains: readonly string[]): boolean {
  const hostname = new URL(originValue).hostname.toLowerCase();
  return allowedDomains.some((domainValue) => {
    const domain = domainValue.toLowerCase();
    if (!domain.startsWith("*.")) return hostname === domain;
    const suffix = domain.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  });
}

function variantScore(
  observation: NormalizedSkillPageObservation,
  signature: ApplicationSkillVersion["content"]["pageVariants"][number]["match"]
): number {
  const routeScore = signature.routePatterns.some((pattern) => routeMatches(observation.route, pattern)) ? 1 : 0;
  const landmarkScore = ratio(signature.requiredTexts, (required) =>
    observation.landmarks.some((landmark) => landmark.includes(normalizeText(required))));
  const semantics = new Set(observation.fields.map((field) => field.semantic));
  const semanticScore = ratio(signature.requiredFields, (required) => semantics.has(required));
  return routeScore * 0.5 + landmarkScore * 0.25 + semanticScore * 0.25;
}

function routeMatches(route: string, patternValue: string): boolean {
  const pattern = normalizeRoute(patternValue);
  return route === pattern || route.startsWith(pattern.endsWith("/") ? pattern : `${pattern}/`);
}

function ratio<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  if (values.length === 0) return 1;
  return values.filter(predicate).length / values.length;
}

function conditionMatches(condition: SkillCondition, context: MatchContext): boolean {
  if (condition.kind === "all") {
    return condition.conditions.every((predicate) => predicateMatches(predicate, context));
  }
  if (condition.kind === "any") {
    return condition.conditions.some((predicate) => predicateMatches(predicate, context));
  }
  if (condition.kind === "not") return !predicateMatches(condition.condition, context);
  return predicateMatches(condition, context);
}

function predicateMatches(
  predicate: Exclude<SkillCondition, { kind: "all" | "any" | "not" }>,
  context: MatchContext
): boolean {
  if (predicate.kind === "page-variant") return predicate.variantId === context.pageVariantId;
  if (predicate.kind === "field-present") {
    return context.observation.fields.some((field) => field.semantic === predicate.semantic);
  }
  if (predicate.kind === "field-empty") {
    return context.observation.fields.some((field) => field.semantic === predicate.semantic && field.empty);
  }
  if (predicate.kind === "challenge-present") return context.observation.challengePresent;
  return context.observation.availableCapabilities.includes(predicate.capability);
}

function uniqueRequestedFields(values: readonly ApplicationFieldSemantic[]): ApplicationFieldSemantic[] {
  const result: ApplicationFieldSemantic[] = [];
  for (const value of values) {
    const parsed = ApplicationFieldSemanticSchema.safeParse(value);
    if (parsed.success && !result.includes(parsed.data)) result.push(parsed.data);
  }
  return result;
}

function pushDirective(directives: SkillDirective[], input: SkillDirective): void {
  directives.push(SkillDirectiveSchema.parse(input));
}

function fingerprint(observation: NormalizedSkillPageObservation, ruleHash: string): string {
  return createHash("sha256").update(canonicalJson({
    ruleHash,
    origin: observation.origin,
    route: observation.route,
    landmarks: [...observation.landmarks].sort(),
    fields: [...observation.fields]
      .map((field) => ({ semantic: field.semantic, empty: field.empty }))
      .sort((left, right) => left.semantic.localeCompare(right.semantic)),
    availableCapabilities: [...observation.availableCapabilities].sort(),
    challengePresent: observation.challengePresent
  }), "utf8").digest("hex");
}

function normalizeRoute(value: string): string {
  const normalized = value.normalize("NFKC").replace(/\/{2,}/gu, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}
