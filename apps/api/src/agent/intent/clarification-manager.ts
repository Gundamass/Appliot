import {
  ClarificationRequestSchema,
  RuntimeHumanResumeSchema,
  type CanonicalIntent,
  type ClarificationRequest,
  type MissingInformation,
  type RuntimeHumanResume
} from "@resume/contracts";
import type { IntentAmbiguity, IntentField } from "@resume/contracts";
import type { IntentCandidate } from "./intent-context.js";

export interface ClarificationManager {
  selectQuestion(missing: MissingInformation[], ambiguities: IntentAmbiguity[], context?: {
    availableJobs?: IntentCandidate[];
    availableResumes?: IntentCandidate[];
  }): ClarificationRequest;
  applyAnswer(intent: CanonicalIntent, answer: RuntimeHumanResume): CanonicalIntent;
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

    applyAnswer(intent, answer) {
      const parsed = RuntimeHumanResumeSchema.parse(answer);
      const entries = Object.entries(parsed.values);
      if (entries.length === 0) throw new Error("clarification_answer_empty");
      const [field, value] = entries[0]!;
      const nextField: IntentField = {
        value,
        source: "user_clarified",
        confidence: 1,
        evidenceRefs: [],
        requiresConfirmation: false
      };
      const missingInformation = intent.missingInformation.filter((item) => item.field !== field);
      const ambiguities = intent.ambiguities.filter((item) => item.field !== field);
      return {
        ...intent,
        revision: intent.revision + 1,
        entities: { ...intent.entities, [field]: nextField },
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
