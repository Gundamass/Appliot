import type { Evidence, JsonValue, ProfileFact } from "@resume/contracts";
import { buildQuestion } from "./questions.js";
import type {
  FieldDecision,
  FieldRequest,
  RetrievalPlan,
  RetrievalResult,
  RetrievedCandidate
} from "./types.js";

const AUTO_CONFIDENCE = 0.85;

export function verifyField(
  request: FieldRequest,
  plan: RetrievalPlan,
  retrieval: RetrievalResult
): FieldDecision {
  const base = {
    fieldId: request.fieldId,
    validators: plan.validators
  };

  if (!plan.valid || retrieval.invalidReason) return blocked(base, [], 0);
  if (retrieval.candidates.length === 0) {
    return {
      ...base,
      status: "needs_question",
      value: undefined,
      evidence: [],
      confidence: 0,
      question: buildQuestion(request, "missing")
    };
  }

  const validations = retrieval.candidates.map((candidate) => validateCandidate(request, plan, candidate));
  const invalid = validations.find((validation) => !validation.valid);
  if (invalid) return blocked(base, invalid.candidate.fact.evidence, safeConfidence(invalid.candidate.fact.confidence));

  const candidates = validations.map(({ candidate }) => candidate);
  const uniqueValues = uniqueCandidateValues(candidates);
  if (uniqueValues.length > 1) {
    return {
      ...base,
      status: "needs_question",
      value: undefined,
      evidence: candidates.flatMap(({ fact }) => fact.evidence),
      confidence: Math.max(...candidates.map(({ fact }) => safeConfidence(fact.confidence))),
      question: buildQuestion(request, "conflict", uniqueValues)
    };
  }

  const selected = candidates[0]!;
  if (!plan.autoFillEligible || plan.risk !== "none") {
    return blocked(base, selected.fact.evidence, safeConfidence(selected.fact.confidence));
  }

  const eligibleLifecycle = selected.fact.status === "user_confirmed" || selected.fact.status === "user_corrected";
  const automatic = selected.source === "exact"
    && eligibleLifecycle
    && selected.fact.confidence >= AUTO_CONFIDENCE;

  return {
    ...base,
    status: automatic ? "verified_auto" : "needs_review",
    value: selected.fact.value,
    evidence: selected.fact.evidence,
    confidence: safeConfidence(selected.fact.confidence)
  };
}

export function validateFieldValue(request: FieldRequest, plan: RetrievalPlan, value: JsonValue): string | undefined {
  const typeFailure = validateType(request, value);
  if (typeFailure) return typeFailure;

  if (request.type === "select" && !request.options?.includes(value as string)) {
    return "value is not one of the field options";
  }
  if (request.type === "date") {
    const dateFailure = validateDate(value as string, plan.requiredRange);
    if (dateFailure) return dateFailure;
  }

  return validateRules(value, plan.validators);
}

export function evidenceSupportsValue(value: JsonValue, evidence: Evidence[]): boolean {
  if (evidence.length === 0) return false;
  const required = supportStrings(value);
  if (required.length === 0) return false;
  const sourceText = evidence.map((item) => normalize(item.text)).join("\n");
  return required.every((item) => sourceText.includes(normalize(item)));
}

function validateCandidate(
  request: FieldRequest,
  plan: RetrievalPlan,
  candidate: RetrievedCandidate
): { candidate: RetrievedCandidate; valid: boolean } {
  const fact = candidate.fact;
  const lifecycleValid = fact.status !== "superseded";
  const scopeValid = fact.scope === "profile" || fact.taskId === request.taskId;
  const valueValid = validateFieldValue(request, plan, fact.value) === undefined;
  const supported = evidenceSupportsValue(fact.value, fact.evidence);
  return { candidate, valid: lifecycleValid && scopeValid && valueValid && supported };
}

function validateType(request: FieldRequest, value: JsonValue): string | undefined {
  if (request.type === "boolean") return typeof value === "boolean" ? undefined : "value must be boolean";
  if (request.type === "text" || request.type === "textarea" || request.type === "select" || request.type === "date") {
    return typeof value === "string" ? undefined : "value must be a string";
  }
  return "unsupported field type";
}

function validateDate(value: string, range: RetrievalPlan["requiredRange"]): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date must use YYYY-MM-DD";
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return "date is not a valid calendar date";
  }
  if (range?.min && value < range.min) return "date is before the required range";
  if (range?.max && value > range.max) return "date is after the required range";
  return undefined;
}

function validateRules(value: JsonValue, validators: string[]): string | undefined {
  for (const validator of validators) {
    if (validator === "required") {
      if (typeof value === "string" && value.trim().length === 0) return "value is required";
      continue;
    }

    const separator = validator.indexOf(":");
    if (separator < 0) return `unsupported validator: ${validator}`;
    const name = validator.slice(0, separator);
    const parameter = validator.slice(separator + 1);
    if (name === "dateMin" || name === "dateMax" || name === "min" || name === "max") continue;
    if (typeof value !== "string") return `validator ${name} requires a string value`;

    if (name === "minLength" || name === "maxLength") {
      const length = Number(parameter);
      if (!Number.isInteger(length) || length < 0) return `invalid ${name} validator`;
      if (name === "minLength" && value.length < length) return "value is shorter than minLength";
      if (name === "maxLength" && value.length > length) return "value is longer than maxLength";
      continue;
    }
    if (name === "pattern") {
      try {
        if (!new RegExp(parameter, "u").test(value)) return "value does not match pattern";
      } catch {
        return "invalid pattern validator";
      }
      continue;
    }
    return `unsupported validator: ${validator}`;
  }
  return undefined;
}

function supportStrings(value: JsonValue): string[] {
  if (typeof value === "string") return value.trim().length === 0 ? [] : [value];
  if (typeof value === "boolean" || typeof value === "number") return [String(value)];
  if (value === null) return ["null"];
  if (Array.isArray(value)) return value.flatMap(supportStrings);
  return Object.values(value).flatMap(supportStrings);
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function uniqueCandidateValues(candidates: RetrievedCandidate[]): JsonValue[] {
  const values: JsonValue[] = [];
  const serialized = new Set<string>();
  for (const { fact } of candidates) {
    const key = stableJson(fact.value);
    if (serialized.has(key)) continue;
    serialized.add(key);
    values.push(fact.value);
  }
  return values;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
}

function blocked(
  base: Pick<FieldDecision, "fieldId" | "validators">,
  evidence: Evidence[],
  confidence: number
): FieldDecision {
  return { ...base, status: "blocked", value: undefined, evidence, confidence };
}

function safeConfidence(confidence: number): number {
  return Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
}
