import type { FieldRequest, RequiredRange, RetrievalPlan } from "./types.js";

const SUPPORTED_ROOTS = new Set([
  "application",
  "basics",
  "certificates",
  "contact",
  "education",
  "experience",
  "languages",
  "preferences",
  "projects",
  "skills",
  "work"
]);

const JOB_SPECIFIC_SEMANTICS = new Set([
  "application.coverLetter",
  "application.jobMotivation",
  "application.whyCompany",
  "application.jobSpecific"
]);

const SENSITIVE_SEGMENT = /(?:salary|compensation|relocat|visa|sponsor|notice|availability|overtime|travel|noncompete|commitment)/i;

export function planField(request: FieldRequest): RetrievalPlan {
  const semantic = request.semantic.trim();
  const validators = normalizeValidators(request.validators ?? []);
  const root = semantic.split(/[.[\]]/, 1)[0] ?? "";
  const knownSemantic = semantic.length > 0 && SUPPORTED_ROOTS.has(root);
  const sensitive = SENSITIVE_SEGMENT.test(semantic);
  const needsJobDescription = JOB_SPECIFIC_SEMANTICS.has(semantic);
  const longText = request.type === "textarea";
  const requiredRange = rangeFrom(validators);
  const invalidReason = validateRequest(request, semantic, knownSemantic, validators, requiredRange);

  return {
    semantic,
    requestType: request.type,
    requiredSources: ["application", "profile"],
    requiredRange,
    needsJobDescription,
    autoFillEligible: knownSemantic && !sensitive,
    risk: !knownSemantic ? "unknown_semantic" : sensitive ? "sensitive_commitment" : "none",
    validators,
    strategy: longText ? ["exact", "keyword", "embedding"] : ["exact", "keyword"],
    valid: invalidReason === undefined,
    ...(invalidReason === undefined ? {} : { invalidReason })
  };
}

function normalizeValidators(validators: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const validator of validators) {
    const value = validator.trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function rangeFrom(validators: string[]): RequiredRange | undefined {
  const range: RequiredRange = {};
  for (const validator of validators) {
    const separator = validator.indexOf(":");
    if (separator < 0) continue;
    const name = validator.slice(0, separator);
    const value = validator.slice(separator + 1);
    if (name === "dateMin" || name === "min") range.min = value;
    if (name === "dateMax" || name === "max") range.max = value;
  }
  return range.min === undefined && range.max === undefined ? undefined : range;
}

function validateRequest(
  request: FieldRequest,
  semantic: string,
  knownSemantic: boolean,
  validators: string[],
  range: RequiredRange | undefined
): string | undefined {
  if (request.taskId.trim().length === 0) return "taskId is required";
  if (request.fieldId.trim().length === 0) return "fieldId is required";
  if (request.label.trim().length === 0) return "field label is required";
  if (semantic.length === 0) return "field semantic is required";
  if (!knownSemantic) return `unknown field semantic: ${semantic}`;
  if (request.type === "select" && (!request.options || request.options.length === 0)) {
    return "select fields require options";
  }
  if (request.options?.some((option) => option.trim().length === 0)) return "field options must be nonempty";
  const validatorFailure = validateValidators(request, validators, range);
  if (validatorFailure) return validatorFailure;
  return undefined;
}

function validateValidators(
  request: FieldRequest,
  validators: string[],
  range: RequiredRange | undefined
): string | undefined {
  for (const validator of validators) {
    if (validator === "required") continue;
    const separator = validator.indexOf(":");
    if (separator < 0) return `unsupported validator: ${validator}`;
    const name = validator.slice(0, separator);
    const parameter = validator.slice(separator + 1);
    if (name === "minLength" || name === "maxLength") {
      const length = Number(parameter);
      if (!Number.isInteger(length) || length < 0) return `invalid ${name} validator`;
      continue;
    }
    if (name === "pattern") {
      try {
        new RegExp(parameter, "u");
      } catch {
        return "invalid pattern validator";
      }
      continue;
    }
    if (name === "dateMin" || name === "dateMax" || name === "min" || name === "max") {
      if (request.type !== "date" || !isStrictDate(parameter)) return `invalid ${name} validator`;
      continue;
    }
    return `unsupported validator: ${validator}`;
  }
  if (range?.min && range.max && range.min > range.max) return "date range minimum exceeds maximum";
  return undefined;
}

function isStrictDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
