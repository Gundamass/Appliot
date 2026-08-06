import { createHash } from "node:crypto";
import type { ApplicationFieldAssessment, ApplicationQuestion, FormField } from "@resume/contracts";
import type { ProfileRepositoryPort, RagService } from "@resume/rag";
import type {
  FieldResolutionPhase,
  FieldSemanticContext,
  FieldSemanticResolver
} from "./field-semantic-resolver.js";

interface ProductionFieldResolverDependencies {
  semanticResolver: FieldSemanticResolver;
  ragService: Pick<RagService, "resolveField">;
  profileRepository: Pick<ProfileRepositoryPort, "resolveForTask">;
}

export function createProductionFieldResolver(dependencies: ProductionFieldResolverDependencies) {
  return async (
    taskId: string,
    field: FormField,
    phase: FieldResolutionPhase = "deterministic"
  ) => {
    const semanticDecision = await dependencies.semanticResolver.resolve(
      field,
      semanticContextForField(field),
      phase
    );
    if (semanticDecision.status === "unresolved") {
      const fieldPath = applicationAnswerPath(field);
      const existingAnswer = taskAnswerForPath(dependencies.profileRepository, taskId, fieldPath);
      if (existingAnswer) return resolvedTaskAnswer(field, fieldPath, existingAnswer.value, existingAnswer.evidence);
      const assessment = fieldAssessment(field, {
        status: phase === "deterministic" ? "unsupported" : "missing",
        source: "none",
        confidence: 0,
        reason: phase === "deterministic" ? "尚未找到确定性字段映射" : "未找到可安全使用的字段映射"
      });
      if (phase === "deterministic" && semanticDecision.reason === "exact_match_not_found") {
        return { status: "deferred" as const, assessment };
      }
      return {
        status: "needs_question" as const,
        fieldPath,
        question: `请补充“${field.label}”，系统未找到可安全使用的字段映射。`,
        assessment
      };
    }
    if (semanticDecision.status === "review") {
      const candidate = semanticDecision.candidates[0];
      const fieldPath = applicationAnswerPath(field);
      const existingAnswer = taskAnswerForPath(dependencies.profileRepository, taskId, fieldPath);
      if (existingAnswer) return resolvedTaskAnswer(field, fieldPath, existingAnswer.value, existingAnswer.evidence);
      return {
        status: "needs_question" as const,
        fieldPath,
        question: semanticReviewQuestion(field.label, semanticDecision.reason),
        assessment: fieldAssessment(field, {
          ...(candidate === undefined ? {} : { semantic: candidate.semantic }),
          status: "review",
          source: "semantic",
          confidence: 0,
          reason: semanticReviewQuestion(field.label, semanticDecision.reason)
        })
      };
    }

    const semantic = semanticDecision.semantic;
    const existing = dependencies.profileRepository.resolveForTask(taskId, semantic);
    if (existing?.scope === "application") {
      return resolvedTaskAnswer(field, semantic, existing.value, existing.evidence);
    }
    const decision = await dependencies.ragService.resolveField({
      taskId,
      fieldId: field.id,
      semantic,
      label: field.label,
      type: fieldTypeForRag(field.type),
      ...(field.options.length === 0 ? {} : { options: field.options }),
      validators: field.required ? ["required"] : []
    });
    const requiresContentReview = decision.status === "needs_review"
      || (semantic === "selfEvaluation" && existing?.scope === "profile");
    const resolvedValue = decision.value === undefined
      ? undefined
      : projectDateComponent(field, semantic, decision.value);
    const assessmentStatus = requiresContentReview
      ? "review" as const
      : decision.status === "verified_auto"
        ? "ready" as const
        : decision.status === "blocked"
          ? "unsupported" as const
          : "missing" as const;
    return {
      status: decision.status === "verified_auto" || decision.status === "needs_review"
        ? "verified" as const
        : decision.status,
      ...(resolvedValue === undefined ? {} : { value: resolvedValue }),
      ...(decision.question === undefined ? {} : { question: decision.question }),
      fieldPath: semantic,
      requiresContentReview,
      assessment: fieldAssessment(field, {
        semantic,
        status: assessmentStatus,
        source: field.semanticSource ?? (semanticDecision.source === "embedding" ? "semantic" : "exact"),
        confidence: assessmentConfidence(assessmentStatus, semanticDecision.confidence, decision.confidence),
        reason: assessmentReason(assessmentStatus),
        evidence: decision.evidence
      }),
      ...(!requiresContentReview ? {} : {
        contentReview: {
          original: typeof existing?.value === "string" ? existing.value : JSON.stringify(existing?.value ?? ""),
          reasons: [semantic === "selfEvaluation"
            ? "自我评价来自长期资料，填写前需要确认是否适合当前岗位。"
            : "该候选值尚未达到自动填写条件，需要你核对后采用。"],
          evidence: decision.evidence,
          unsupportedClaims: [],
          status: "needs_review" as const
        }
      })
    };
  };
}

function projectDateComponent(field: FormField, semantic: string, value: unknown): unknown {
  if (!/(?:^|\.)(?:startDate|endDate|birthDate|date)$/u.test(semantic)
    || typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  if (/\s年$/u.test(field.label)) return value.slice(0, 4);
  if (/\s月$/u.test(field.label)) return value.slice(5, 7);
  if (/\s日$/u.test(field.label)) return value.slice(8, 10);
  return value;
}

export function fieldPathForApplicationAnswer(
  field: Pick<FormField, "id" | "label" | "semanticHint">,
  questions: readonly Pick<ApplicationQuestion, "id" | "fieldPath">[]
): string {
  return questions.find((question) => question.id === field.id)?.fieldPath
    ?? semanticForField(field.semanticHint, field.label);
}

function taskAnswerForPath(
  profileRepository: Pick<ProfileRepositoryPort, "resolveForTask">,
  taskId: string,
  fieldPath: string
) {
  const fact = profileRepository.resolveForTask(taskId, fieldPath);
  return fact?.scope === "application" ? fact : undefined;
}

function resolvedTaskAnswer(
  field: FormField,
  fieldPath: string,
  value: unknown,
  evidence: ApplicationFieldAssessment["evidence"]
) {
  return {
    status: "verified" as const,
    value,
    fieldPath,
    assessment: fieldAssessment(field, {
      semantic: fieldPath,
      status: "ready",
      source: "user",
      confidence: 1,
      reason: "本次投递已确认该字段的用户答案",
      evidence
    })
  };
}

function applicationAnswerPath(field: Pick<FormField, "label" | "type" | "options" | "semanticHint">): string {
  const signature = JSON.stringify({
    context: field.semanticHint ?? "",
    label: normalizeSignaturePart(field.label),
    type: field.type,
    options: field.options.map(normalizeSignaturePart).sort()
  });
  const digest = createHash("sha256").update(signature).digest("hex").slice(0, 24);
  return `application.fieldAnswers.${digest}`;
}

function normalizeSignaturePart(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function assessmentConfidence(
  status: ApplicationFieldAssessment["status"],
  semanticConfidence: number,
  valueConfidence: number
): number {
  if (status === "missing" || status === "unsupported") return 0;
  const confidence = Math.min(semanticConfidence, valueConfidence);
  return status === "review" ? Math.min(confidence, 0.89) : confidence;
}

function fieldAssessment(
  field: FormField,
  input: Omit<ApplicationFieldAssessment, "fieldId" | "label" | "evidence"> & {
    evidence?: ApplicationFieldAssessment["evidence"];
  }
): ApplicationFieldAssessment {
  return {
    fieldId: field.id,
    label: field.label,
    ...input,
    evidence: input.evidence ?? []
  };
}

function assessmentReason(status: ApplicationFieldAssessment["status"]): string {
  if (status === "ready") return "字段映射和资料值均已通过验证";
  if (status === "review") return "该字段需要用户审核后才能填写";
  if (status === "missing") return "档案中没有可安全使用的已确认资料";
  return "当前字段不支持安全自动填写";
}

function semanticContextForField(field: FormField): FieldSemanticContext {
  const entryContext = field.semanticHint
    ?.match(/^(education|work|projects|campus|awards|publications|certificates)\[\d+\]/u)?.[0];
  const root = (entryContext ?? field.semanticHint)?.split(/[.[\]]/u, 1)[0];
  const section = root === "identity"
    ? "basics"
    : root === "selfEvaluation"
      ? "self"
      : root && [
        "basics", "preferences", "education", "work", "projects", "campus",
        "awards", "publications", "certificates"
      ].includes(root)
        ? root
        : undefined;
  const context: FieldSemanticContext = {};
  if (section !== undefined) {
    context.section = section as NonNullable<FieldSemanticContext["section"]>;
  }
  if (entryContext !== undefined) context.entryContext = entryContext;
  return context;
}

function semanticReviewQuestion(
  label: string,
  reason: "similarity_below_threshold" | "ambiguous_candidates" | "risk_requires_review"
): string {
  if (reason === "risk_requires_review") return `请确认“${label}”，该字段涉及敏感信息或求职承诺。`;
  if (reason === "ambiguous_candidates") return `请确认“${label}”，系统找到了多个含义接近的档案字段。`;
  return `请补充“${label}”，当前字段映射置信度不足。`;
}

function fieldTypeForRag(type: FormField["type"]) {
  if (type === "checkbox") return "boolean" as const;
  if (type === "radio") return "select" as const;
  if (type === "file") return "text" as const;
  return type;
}

function semanticForField(hint: string | undefined, label: string): string {
  const value = `${hint ?? ""} ${label}`.toLocaleLowerCase();
  if (/e-?mail|邮箱/u.test(value)) return "basics.email";
  if (/city|城市/u.test(value)) return "preferences.city";
  if (/self.?evaluation|自我评价/u.test(value)) return "selfEvaluation";
  return hint?.includes(".") ? hint : `application.${hint || "jobSpecific"}`;
}
