import { createHash } from "node:crypto";
import type { ApplicationFieldAssessment, ApplicationQuestion, FormField } from "@resume/contracts";
import type { ProfileRepositoryPort, RagService } from "@resume/rag";
import type {
  FieldResolutionPhase,
  FieldSemanticContext,
  FieldSemanticResolver
} from "./field-semantic-resolver.js";
import { isCanonicalDateSemantic, matchControlOption, projectDateComponent } from "./control-value.js";

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
        return { status: "deferred" as const, fieldPath, assessment };
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
    const splitDateSelect = isSplitDateSelect(field, semantic);
    const truncatedNativeSelect = isTruncatedNativeSelect(field);
    const customSearchSelect = isCustomSearchSelect(field);
    const existing = dependencies.profileRepository.resolveForTask(taskId, semantic);
    if (existing?.scope === "application") {
      return resolvedTaskAnswer(field, semantic, existing.value, existing.evidence);
    }
    if (field.type === "file" && existing?.scope === "profile" && typeof existing.value === "string" && existing.value.trim() !== "") {
      return resolvedProfileFile(field, semantic, existing.value, existing.evidence, semanticDecision.confidence);
    }
    if (isLaboratoryPresenceSemantic(semantic)) {
      const source = existing ?? dependencies.profileRepository.resolveForTask(
        taskId,
        semantic.replace(/\.hasLaboratory$/u, ".laboratory")
      );
      const value = laboratoryPresenceValue(field, existing, source);
      if (value !== undefined && source !== undefined) {
        return resolvedDerivedProfileValue(field, semantic, value, source.evidence, semanticDecision.confidence);
      }
    }
    if (existing?.scope !== "profile") {
      return missingProfileFact(field, semantic);
    }
    const decision = await dependencies.ragService.resolveField({
      taskId,
      fieldId: field.id,
      semantic,
      label: field.label,
      type: splitDateSelect ? "date" : truncatedNativeSelect || customSearchSelect ? "text" : fieldTypeForRag(field.type),
      ...(field.options.length === 0 || splitDateSelect || truncatedNativeSelect || customSearchSelect ? {} : { options: field.options }),
      validators: field.required ? ["required"] : []
    });
    const resolvedValue = decision.value === undefined
      ? undefined
      : projectDateComponent(field.label, semantic, decision.value);
    const matchedSplitDateOption = splitDateSelect
      && typeof resolvedValue === "string"
      && field.controlKind !== "custom"
      ? matchControlOption(resolvedValue, field.options)
      : resolvedValue;
    const projectedOptionMismatch = splitDateSelect
      && (decision.status === "verified_auto" || decision.status === "needs_review")
      && (typeof resolvedValue !== "string"
        || (field.controlKind !== "custom" && matchedSplitDateOption === undefined));
    const decisionStatus = projectedOptionMismatch ? "blocked" as const : decision.status;
    const effectiveValue = projectedOptionMismatch ? undefined : matchedSplitDateOption;
    const requiresContentReview = decisionStatus === "needs_review"
      || (semantic === "selfEvaluation" && existing?.scope === "profile");
    const assessmentStatus = requiresContentReview
      ? "review" as const
      : decisionStatus === "verified_auto"
        ? "ready" as const
        : decisionStatus === "blocked"
          ? "unsupported" as const
          : "missing" as const;
    return {
      status: decisionStatus === "verified_auto" || decisionStatus === "needs_review"
        ? "verified" as const
        : decisionStatus,
      ...(effectiveValue === undefined ? {} : { value: effectiveValue }),
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

function isSplitDateSelect(field: FormField, semantic: string): boolean {
  return fieldTypeForRag(field.type) === "select"
    && isCanonicalDateSemantic(semantic)
    && /\s[年月日]$/u.test(field.label);
}

function isTruncatedNativeSelect(field: FormField): boolean {
  return field.type === "select"
    && field.controlKind !== "custom"
    && field.optionsTruncated === true;
}

function isCustomSearchSelect(field: FormField): boolean {
  return field.type === "select"
    && field.controlKind === "custom"
    && field.interactionMode === "search";
}

function isLaboratoryPresenceSemantic(semantic: string): boolean {
  return /^education\[\d+\]\.hasLaboratory$/u.test(semantic);
}

function laboratoryPresenceValue(
  field: FormField,
  explicit: ReturnType<ProfileRepositoryPort["resolveForTask"]>,
  source: ReturnType<ProfileRepositoryPort["resolveForTask"]>
): unknown | undefined {
  const explicitValue = explicit?.value;
  if (typeof explicitValue === "boolean") return booleanControlValue(field, explicitValue);
  if (typeof explicitValue === "string" && explicitValue.trim() !== "") {
    const normalized = explicitValue.normalize("NFKC").trim().toLocaleLowerCase();
    if (["true", "yes", "y", "\u662f"].includes(normalized)) return booleanControlValue(field, true);
    if (["false", "no", "n", "\u5426"].includes(normalized)) return booleanControlValue(field, false);
  }
  if (typeof source?.value !== "string" || source.value.trim() === "") return undefined;
  const normalizedSource = source.value.normalize("NFKC").trim().toLocaleLowerCase();
  const negative = ["false", "no", "n", "否", "无", "没有", "无实验室经历", "无相关经历"]
    .includes(normalizedSource);
  return booleanControlValue(field, !negative);
}

function booleanControlValue(field: FormField, value: boolean): boolean | string | undefined {
  if (field.type === "checkbox") return value;
  const aliases = value ? ["true", "yes", "y", "\u662f"] : ["false", "no", "n", "\u5426"];
  const option = field.options.find((candidate) =>
    aliases.includes(candidate.normalize("NFKC").trim().toLocaleLowerCase()));
  if (option !== undefined) return option;
  return field.controlKind === "custom" ? value ? "\u662f" : "\u5426" : undefined;
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

function resolvedProfileFile(
  field: FormField,
  fieldPath: string,
  value: string,
  evidence: ApplicationFieldAssessment["evidence"],
  confidence: number
) {
  return {
    status: "verified" as const,
    value,
    fieldPath,
    assessment: fieldAssessment(field, {
      semantic: fieldPath,
      status: "ready",
      source: "exact",
      confidence,
      reason: "文件字段已精确映射到本地候选人档案",
      evidence
    })
  };
}

function resolvedDerivedProfileValue(
  field: FormField,
  fieldPath: string,
  value: unknown,
  evidence: ApplicationFieldAssessment["evidence"],
  confidence: number
) {
  return {
    status: "verified" as const,
    value,
    fieldPath,
    assessment: fieldAssessment(field, {
      semantic: fieldPath,
      status: "ready",
      source: "exact",
      confidence,
      reason: "该值由已确认的候选人档案事实推导",
      evidence
    })
  };
}

function missingProfileFact(field: FormField, fieldPath: string) {
  const reason = "候选人档案中没有该字段对应的已确认资料";
  return {
    status: "needs_question" as const,
    fieldPath,
    question: `请补充“${field.label}”，${reason}。`,
    assessment: fieldAssessment(field, {
      semantic: fieldPath,
      status: "missing",
      source: "none",
      confidence: 0,
      reason
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
    ...(input.source === "certified_hint" && field.semanticProvenance !== undefined
      ? { semanticProvenance: field.semanticProvenance }
      : {}),
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
    ?.match(/^(education|work|projects|campus|awards|publications|languages|certificates)\[\d+\]/u)?.[0];
  const root = (entryContext ?? field.semanticHint)?.split(/[.[\]]/u, 1)[0];
  const observedSection = field.sectionHint === "internship" || field.sectionHint === "work_combined"
    ? "work"
    : field.sectionHint;
  const section = observedSection ?? (root === "identity"
    ? "basics"
    : root === "selfEvaluation"
      ? "self"
      : root && [
        "basics", "preferences", "education", "work", "projects", "campus",
        "awards", "publications", "languages", "certificates"
      ].includes(root)
        ? root
        : undefined);
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
