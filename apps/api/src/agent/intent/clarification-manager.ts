import {
  ClarificationRequestSchema,
  RuntimeHumanResumeSchema,
  type CanonicalIntent,
  type ClarificationRequest,
  type MissingInformation,
  type RuntimeHumanResume
} from "@resume/contracts";
import type { IntentAmbiguity, IntentField, JsonValue } from "@resume/contracts";
import type { IntentCandidate } from "./intent-context.js";

const MAX_RELATED_FIELDS = 32;
const MAX_VALUE_DEPTH = 8;
const MAX_VALUE_NODES = 256;
const MAX_VALUE_STRING_LENGTH = 4_096;
const MAX_VALUES_BYTES = 32_000;
const SENSITIVE_FIELD = /(?:cookie|password|passwd|token|secret|authorization|credential|prompt|playwright|page[_-]?handle|full[_-]?dom|html|binary)/iu;

export interface ClarificationManager {
  selectQuestion(missing: MissingInformation[], ambiguities: IntentAmbiguity[], context?: {
    availableJobs?: IntentCandidate[];
    availableResumes?: IntentCandidate[];
  }): ClarificationRequest;
  applyAnswer(intent: CanonicalIntent, answer: RuntimeHumanResume, relatedFields: readonly string[]): CanonicalIntent;
}

export function createClarificationManager(): ClarificationManager {
  return {
    selectQuestion(missing, ambiguities, context = {}) {
      const selected = [...missing].sort((left, right) => right.priority - left.priority)[0];
      if (selected === undefined) {
        const ambiguity = ambiguities[0];
        if (ambiguity === undefined) throw new Error("clarification_not_required");
        return ClarificationRequestSchema.parse({
          questionId: `clarify-${ambiguity.id}`,
          question: `请确认${labelForField(ambiguity.field)}`,
          blocking: true,
          relatedFields: [ambiguity.field]
        });
      }

      const options = selected.field === "targetJob"
        ? context.availableJobs?.map((job) => ({ id: job.id, label: job.label, value: job.id }))
        : selected.field === "resumeRef"
          ? context.availableResumes?.map((resume) => ({ id: resume.id, label: resume.label, value: resume.id }))
          : undefined;
      return ClarificationRequestSchema.parse({
        questionId: `clarify-${selected.field}`,
        question: questionForField(selected.field),
        ...(options === undefined || options.length === 0 ? {} : { options }),
        blocking: selected.blocking,
        relatedFields: [selected.field]
      });
    },

    applyAnswer(intent, answer, relatedFields) {
      const parsed = RuntimeHumanResumeSchema.parse(answer);
      const allowedFields = validateRelatedFields(relatedFields);
      const entries = Object.entries(parsed.values);
      if (entries.length === 0) throw new Error("clarification_answer_empty");
      const values = validateAnswerValues(entries, allowedFields);
      let entities = { ...intent.entities };
      let missingInformation = intent.missingInformation;
      let ambiguities = intent.ambiguities;
      for (const [field, value] of values) {
        const nextField: IntentField = {
          value,
          source: "user_clarified",
          confidence: 1,
          evidenceRefs: [],
          requiresConfirmation: false
        };
        entities = { ...entities, [field]: nextField };
        missingInformation = missingInformation.filter((item) => item.field !== field);
        ambiguities = ambiguities.filter((item) => item.field !== field);
      }
      return {
        ...intent,
        revision: intent.revision + 1,
        entities,
        ambiguities,
        missingInformation
      };
    }
  };
}

function questionForField(field: string): string {
  switch (field) {
    case "targetJob": return "请选择要申请的目标岗位";
    case "resumeRef": return "请选择要使用的简历";
    default: return `请补充${labelForField(field)}`;
  }
}

function labelForField(field: string): string {
  switch (field) {
    case "targetJob": return "目标岗位";
    case "resumeRef": return "申请简历";
    default: return field;
  }
}

function validateRelatedFields(relatedFields: readonly string[]): string[] {
  if (!Array.isArray(relatedFields) || relatedFields.length === 0 || relatedFields.length > MAX_RELATED_FIELDS) {
    throw new Error("clarification_binding_invalid");
  }
  const unique = [...new Set(relatedFields)];
  if (unique.length !== relatedFields.length || unique.some((field) => {
    return typeof field !== "string"
      || field.length === 0
      || field.length > 128
      || SENSITIVE_FIELD.test(field)
      || /^(?:__proto__|prototype|constructor)$/u.test(field);
  })) {
    throw new Error("clarification_binding_invalid");
  }
  return unique;
}

function validateAnswerValues(
  entries: Array<[string, JsonValue]>,
  allowedFields: readonly string[]
): Array<[string, JsonValue]> {
  const allowed = new Set(allowedFields);
  const encoded = JSON.stringify(Object.fromEntries(entries));
  if (encoded.length > MAX_VALUES_BYTES) throw new Error("clarification_answer_too_large");
  let nodes = 0;
  for (const [field, value] of entries) {
    if (SENSITIVE_FIELD.test(field)) throw new Error("clarification_answer_sensitive_field");
    if (!allowed.has(field)) throw new Error("clarification_answer_field_invalid");
    validateJsonValue(value, field, 0, { count: () => { nodes += 1; return nodes; } });
  }
  return entries;
}

function validateJsonValue(
  value: JsonValue,
  path: string,
  depth: number,
  counter: { count(): number }
): void {
  if (counter.count() > MAX_VALUE_NODES) throw new Error("clarification_answer_too_large");
  if (depth > MAX_VALUE_DEPTH) throw new Error("clarification_answer_too_deep");
  if (typeof value === "string") {
    if (value.length > MAX_VALUE_STRING_LENGTH) throw new Error("clarification_answer_value_too_large");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_VALUE_NODES) throw new Error("clarification_answer_too_large");
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, depth + 1, counter));
    return;
  }
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value);
    if (fields.length > MAX_VALUE_NODES) throw new Error("clarification_answer_too_large");
    for (const [key, nested] of fields) {
      if (SENSITIVE_FIELD.test(key)) throw new Error("clarification_answer_sensitive_field");
      validateJsonValue(nested, `${path}.${key}`, depth + 1, counter);
    }
  }
}
