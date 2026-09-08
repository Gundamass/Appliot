import { z } from "zod";
import {
  IntentConstraintSchema,
  IntentEntitiesSchema,
  IntentPreferenceSchema,
  IntentValueSourceSchema,
  PrimaryGoalSchema,
  SubGoalSchema,
  SuccessCriterionSchema,
  type IntentField,
  type IntentValueSource
} from "@resume/contracts";
import { JsonValueSchema } from "@resume/contracts";
import type { StructuredModelProvider } from "@resume/model-provider";
import type { IntentContext, IntentDraft, UserMessage } from "./intent-context.js";
import type { IntentResolutionRuntimeContext } from "./intent-resolver.js";

const ExtractedFieldSchema = z.object({
  value: JsonValueSchema,
  source: IntentValueSourceSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidenceRefs: z.array(z.string().min(1).max(128)).max(100).optional(),
  requiresConfirmation: z.boolean().optional()
}).strict();

const IntentExtractionSchema = z.object({
  primaryGoal: PrimaryGoalSchema.optional(),
  subGoals: z.array(SubGoalSchema).max(32).optional(),
  entities: z.record(z.string().min(1).max(128), ExtractedFieldSchema).default({}),
  constraints: z.array(IntentConstraintSchema).default([]),
  preferences: z.array(IntentPreferenceSchema).default([]),
  successCriteria: z.array(SuccessCriterionSchema).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  autonomyLevel: z.enum(["suggest", "prepare", "execute_with_approval"]).optional(),
  evidenceRefs: z.array(z.string().min(1).max(128)).max(500).default([])
}).strict();

type ExtractedField = z.infer<typeof ExtractedFieldSchema>;

export interface IntentExtractor {
  (input: UserMessage, context: IntentContext, runtime?: IntentResolutionRuntimeContext): Promise<unknown> | unknown;
}

export interface IntentUnderstanding {
  extract(input: UserMessage, context?: IntentContext, runtime?: IntentResolutionRuntimeContext): Promise<IntentDraft>;
}

export interface IntentUnderstandingOptions {
  extractor?: IntentExtractor;
  /** Optional structured model used for nuanced multi-step intent parsing. */
  structuredProvider?: StructuredModelProvider;
}

export function createIntentUnderstanding(options: IntentUnderstandingOptions = {}): IntentUnderstanding {
  return {
    async extract(input, context = emptyContext(), runtime) {
      const deterministic = deterministicExtraction(input.text);
      const raw = options.extractor !== undefined
        ? await options.extractor(input, context, runtime)
        : options.structuredProvider === undefined
          ? deterministic
          : await structuredExtraction(options.structuredProvider, input, context, deterministic, runtime);
      const parsed = IntentExtractionSchema.safeParse(raw);
      if (!parsed.success) throw new Error("intent_extraction_invalid");

      const allowedEvidenceIds = new Set((context.evidenceRefs ?? []).map((ref) => ref.id));
      const entities = Object.fromEntries(Object.entries(parsed.data.entities).map(([key, field]) => [
        key,
        normalizeField(field, allowedEvidenceIds)
      ])) as IntentDraft["entities"];

      return {
        ...(parsed.data.primaryGoal === undefined ? {} : { primaryGoal: parsed.data.primaryGoal }),
        subGoals: parsed.data.subGoals ?? [],
        entities,
        constraints: parsed.data.constraints.map((constraint) => ({
          ...constraint,
          evidenceRefs: sanitizeEvidenceRefs(constraint.evidenceRefs, allowedEvidenceIds)
        })),
        preferences: parsed.data.preferences.map((preference) => ({
          ...preference,
          evidenceRefs: sanitizeEvidenceRefs(preference.evidenceRefs, allowedEvidenceIds)
        })),
        successCriteria: parsed.data.successCriteria,
        confidence: parsed.data.confidence,
        ...(parsed.data.autonomyLevel === undefined ? {} : { autonomyLevel: parsed.data.autonomyLevel }),
        evidenceRefs: context.evidenceRefs === undefined
          ? []
          : context.evidenceRefs.filter((ref) => parsed.data.evidenceRefs.includes(ref.id))
      };
    }
  };
}

async function structuredExtraction(
  provider: StructuredModelProvider,
  input: UserMessage,
  context: IntentContext,
  fallback: z.input<typeof IntentExtractionSchema>,
  runtime?: IntentResolutionRuntimeContext
): Promise<unknown> {
  if (runtime?.signal.aborted) return fallback;
  try {
    const result = await provider.generateStructured({
      system: INTENT_SYSTEM_PROMPT,
      user: JSON.stringify({
        message: input.text,
        context: projectIntentContext(context),
        runtime: { executionEpoch: runtime?.executionEpoch ?? 0 }
      }),
      schema: IntentExtractionSchema,
      jsonExample: INTENT_JSON_EXAMPLE
    });
    return IntentExtractionSchema.safeParse(result).success ? result : fallback;
  } catch {
    return fallback;
  }
}

const INTENT_SYSTEM_PROMPT = [
  "你是招聘申请工作台的意图理解器。",
  "把用户消息转换成严格 JSON；只选择给定的 primaryGoal/subGoals 枚举。",
  "区分分析、匹配、准备、填写、核验和提交意图；如果用户要求提交，仍必须保留人工确认约束。",
  "实体、约束和偏好只能引用用户消息或 context 中的候选 ID；无法确认的内容使用 model_inference 且 requiresConfirmation=true。",
  "evidenceRefs 只能使用 context.evidenceRefs 中的 id；不要输出凭证、token、DOM、HTML 或表单值。",
  "只返回 JSON，不要解释。"
].join("\n");

const INTENT_JSON_EXAMPLE = {
  primaryGoal: "fill_application",
  subGoals: ["prepare_application", "fill_application", "verify_application", "request_human_approval"],
  entities: {
    company: {
      value: "company-id-or-name",
      source: "user_explicit",
      confidence: 1,
      evidenceRefs: [],
      requiresConfirmation: false
    }
  },
  constraints: [],
  preferences: [],
  successCriteria: [{ id: "application_ready", description: "完成填写并在提交前复核", required: true }],
  confidence: 0.8,
  autonomyLevel: "execute_with_approval",
  evidenceRefs: []
};

function projectIntentContext(context: IntentContext): Record<string, unknown> {
  return {
    availableJobs: context.availableJobs.slice(0, 100).map(({ id, label }) => ({ id, label })),
    availableResumes: context.availableResumes.slice(0, 100).map(({ id, label }) => ({ id, label })),
    evidenceRefs: (context.evidenceRefs ?? []).slice(0, 100).map(({ id, kind }) => ({ id, kind })),
    externalContent: (context.externalContent ?? []).slice(0, 10).map((content) => content.slice(0, 4_000)),
    previousIntent: context.previousIntent === undefined
      ? undefined
      : {
          primaryGoal: context.previousIntent.primaryGoal,
          subGoals: context.previousIntent.subGoals,
          confidence: context.previousIntent.confidence
        }
  };
}

function normalizeField(field: ExtractedField, allowedEvidenceIds: ReadonlySet<string>): IntentField {
  const source: IntentValueSource = field.source ?? "model_inference";
  return {
    value: field.value,
    source,
    confidence: field.confidence ?? (source === "user_explicit" ? 1 : 0.7),
    evidenceRefs: sanitizeEvidenceRefs(field.evidenceRefs ?? [], allowedEvidenceIds),
    requiresConfirmation: field.requiresConfirmation ?? source === "model_inference"
  };
}

function sanitizeEvidenceRefs(values: readonly string[], allowedEvidenceIds: ReadonlySet<string>): string[] {
  return [...new Set(values.filter((value) => allowedEvidenceIds.has(value)))].slice(0, 100);
}

function deterministicExtraction(text: string): z.input<typeof IntentExtractionSchema> {
  const normalized = text.trim();
  const isFill = /填写|填表|申请表/u.test(normalized);
  const isApplication = /投|申请|应聘|投递/u.test(normalized) || isFill;
  const isSubmit = /提交|直接投/u.test(normalized) && !/提交前.*确认|确认.*提交/u.test(normalized);
  const primaryGoal = isApplication
    ? (isSubmit ? "submit_application" : isFill && !/投|申请|应聘|投递/u.test(normalized) ? "fill_application" : "prepare_application")
    : /简历.*(分析|解析)|分析.*简历/u.test(normalized)
      ? "analyze_resume"
      : /岗位.*(分析|理解)|分析.*岗位/u.test(normalized)
        ? "analyze_job"
        : /匹配|适合/u.test(normalized)
          ? "match_resume_to_job"
          : undefined;

  const subGoals: Array<z.infer<typeof SubGoalSchema>> = [];
  if (isApplication) {
    subGoals.push("identify_target_job", "analyze_job", "match_resume_to_job", "prepare_application");
    if (/填|填写/u.test(normalized)) subGoals.push("fill_application");
    subGoals.push("verify_application");
    if (isSubmit || /确认|人工|让我/u.test(normalized)) subGoals.push("request_human_approval");
    if (isSubmit) subGoals.push("submit_application");
  } else if (primaryGoal === "analyze_job") {
    subGoals.push("identify_target_job", "analyze_job");
  } else if (primaryGoal === "match_resume_to_job") {
    subGoals.push("identify_target_job", "match_resume_to_job");
  }

  const entities: Record<string, ExtractedField> = {};
  const companyMatch = normalized.match(/(?:申请|投递|应聘)\s*([^\s，。,]+)的(?:后端|前端|算法|测试|产品|运营|开发|工程师)?(?:岗位|职位)/u);
  if (companyMatch?.[1] !== undefined && companyMatch[1] !== "这个") {
    entities.company = explicitField(companyMatch[1]);
  }
  const roleMatch = normalized.match(/(后端|前端|算法|测试|产品|运营|开发|工程师)/u);
  if (roleMatch?.[1] !== undefined) entities.role = explicitField(roleMatch[1]);
  const urlMatch = normalized.match(/https?:\/\/[^\s，。,]+/u);
  if (urlMatch?.[0] !== undefined) entities.applicationUrl = explicitField(urlMatch[0]);
  if (/最新简历/u.test(normalized)) entities.resumeRef = explicitField("latest");

  const constraints: z.input<typeof IntentConstraintSchema>[] = [];
  if (isApplication) {
    constraints.push({
      type: "submit_requires_approval",
      value: true,
      source: "user_explicit",
      confidence: 1,
      evidenceRefs: [],
      requiresConfirmation: false
    });
  }

  return {
    ...(primaryGoal === undefined ? {} : { primaryGoal }),
    subGoals,
    entities,
    constraints,
    preferences: [],
    successCriteria: isApplication
      ? [{ id: "application_ready", description: "完成申请准备并在提交前请求人工确认", required: true }]
      : [],
    confidence: primaryGoal === undefined ? 0 : 0.9,
    ...(isApplication ? { autonomyLevel: "execute_with_approval" as const } : {})
  };
}

function explicitField(value: string): ExtractedField {
  return { value, source: "user_explicit", confidence: 1, evidenceRefs: [], requiresConfirmation: false };
}

function emptyContext(): IntentContext {
  return { availableJobs: [], availableResumes: [] };
}
