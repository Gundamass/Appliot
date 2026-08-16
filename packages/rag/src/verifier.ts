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
  const eligibleLifecycle = selected.fact.status === "user_confirmed" || selected.fact.status === "user_corrected";
  const explicitlyProvided = selected.source === "exact"
    && eligibleLifecycle
    && selected.fact.evidence.length > 0
    && selected.fact.evidence.every((item) => item.extraction === "user");
  const explicitSensitiveAnswer = plan.risk === "sensitive_commitment" && explicitlyProvided;
  if ((!plan.autoFillEligible || plan.risk !== "none") && !explicitSensitiveAnswer) {
    return blocked(base, selected.fact.evidence, safeConfidence(selected.fact.confidence));
  }

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
    const dateFailure = validateDate(value as string, plan.requiredRange, request.semantic);
    if (dateFailure) return dateFailure;
  }

  return validateRules(value, plan.validators);
}

export function evidenceSupportsValue(value: JsonValue, evidence: Evidence[]): boolean {
  return evidence.some((item) => item.extraction === "user"
    ? userEvidenceSupportsValue(value, item.text)
    : documentEvidenceSupportsValue(value, item.text));
}

function validateCandidate(
  request: FieldRequest,
  plan: RetrievalPlan,
  candidate: RetrievedCandidate
): { candidate: RetrievedCandidate; valid: boolean } {
  const fact = candidate.fact;
  const lifecycleValid = fact.status !== "superseded";
  const scopeValid = fact.scope === "profile"
    ? fact.taskId === undefined
    : fact.taskId === request.taskId;
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

function validateDate(
  value: string,
  range: RetrievalPlan["requiredRange"],
  semantic: string
): string | undefined {
  if (allowsMonthPrecision(semantic) && /^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split("-").map(Number) as [number, number];
    if (year < 1 || month < 1 || month > 12) return "date is not a valid calendar month";
    if (range?.min && value < range.min) return "date is before the required range";
    if (range?.max && value > range.max) return "date is after the required range";
    return undefined;
  }
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

function allowsMonthPrecision(semantic: string): boolean {
  return /^(?:education|projects|work|campus)\[\d+\]\.(?:startDate|endDate)$/u.test(semantic)
    || /^awards\[\d+\]\.date$/u.test(semantic);
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

function userEvidenceSupportsValue(value: JsonValue, text: string): boolean {
  const encoded = JSON.stringify(value);
  const focused = text.trim();
  if (focused === encoded) return true;
  if (typeof value === "string" && focused === value) return true;
  return focused === `Corrected value: ${encoded}`;
}

function documentEvidenceSupportsValue(value: JsonValue, text: string): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  const source = normalize(text);
  const term = normalize(value);
  let start = source.indexOf(term);
  while (start >= 0) {
    const end = start + term.length;
    if (hasTokenBoundaries(source, start, end) && !hasNearbyNegation(source, start, end)) return true;
    start = source.indexOf(term, start + 1);
  }
  return false;
}

function hasTokenBoundaries(source: string, start: number, end: number): boolean {
  const term = source.slice(start, end);
  const startsAsciiWord = isAsciiWord(term[0]);
  const endsAsciiWord = isAsciiWord(term.at(-1));
  return (!startsAsciiWord || !isAsciiWord(source[start - 1]))
    && (!endsAsciiWord || !isAsciiWord(source[end]));
}

function isAsciiWord(character: string | undefined): boolean {
  return character !== undefined && /[a-z0-9_]/.test(character);
}

function hasNearbyNegation(source: string, start: number, end: number): boolean {
  const before = source.slice(Math.max(0, start - 32), start);
  const after = source.slice(end, Math.min(source.length, end + 48));
  return hasPrecedingNegation(before) || hasImmediateNegativeAnswer(after);
}

function hasPrecedingNegation(context: string): boolean {
  const english = /\b(?:no|not|never|without|lacks?|does\s+not|do\s+not|did\s+not|has\s+not|have\s+not|cannot|can't)\b[^.!?;，。！？；\n]{0,20}$/;
  const chinese = /(?:未持有|未获得|未通过|没有|不具备|并无|无)[^，。！？；\n]{0,12}$/;
  return english.test(context) || chinese.test(context);
}

function hasImmediateNegativeAnswer(context: string): boolean {
  for (let index = 0; index <= 24 && index < context.length;) {
    const character = codePointAt(context, index);
    if (isStatementTerminator(character)) return false;
    if (!isClauseSeparator(character)) {
      index += character.length;
      continue;
    }

    let answerStart = index;
    while (answerStart < context.length) {
      const separator = codePointAt(context, answerStart);
      if (isStatementTerminator(separator)) return false;
      if (!isClauseSeparator(separator)) break;
      answerStart += separator.length;
    }
    if (isStandaloneNegativeAnswer(context.slice(answerStart))) return true;
    index = answerStart;
  }
  return false;
}

function codePointAt(value: string, index: number): string {
  return String.fromCodePoint(value.codePointAt(index)!);
}

function isClauseSeparator(character: string): boolean {
  return /[\p{P}\p{S}\s]/u.test(character);
}

function isStatementTerminator(character: string): boolean {
  return character === "." || character === "。";
}

function isStandaloneNegativeAnswer(answer: string): boolean {
  const markers = ["no", "false", "none", "absent", "not", "not currently", "not held", "not certified"];
  const chineseMarkers = ["否", "没有", "未持有", "不具备", "无"];
  return markers.some((marker) => startsWithStandaloneMarker(answer, marker))
    || chineseMarkers.some((marker) => startsWithStandaloneMarker(answer, marker));
}

function startsWithStandaloneMarker(answer: string, marker: string): boolean {
  if (!answer.startsWith(marker)) return false;
  if (answer.length === marker.length) return true;
  return /[\p{P}\p{S}]/u.test(codePointAt(answer, marker.length));
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/ *\n */g, "\n");
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
