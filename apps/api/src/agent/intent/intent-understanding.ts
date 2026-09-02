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
import type { IntentContext, IntentDraft, UserMessage } from "./intent-context.js";

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
  (input: UserMessage, context: IntentContext): Promise<unknown> | unknown;
}

export interface IntentUnderstanding {
  extract(input: UserMessage, context?: IntentContext): Promise<IntentDraft>;
}

export interface IntentUnderstandingOptions {
  extractor?: IntentExtractor;
}

export function createIntentUnderstanding(options: IntentUnderstandingOptions = {}): IntentUnderstanding {
  return {
    async extract(input, context = emptyContext()) {
      const raw = options.extractor === undefined
        ? deterministicExtraction(input.text)
        : await options.extractor(input, context);
      const parsed = IntentExtractionSchema.safeParse(raw);
      if (!parsed.success) throw new Error("intent_extraction_invalid");

      const entities = Object.fromEntries(Object.entries(parsed.data.entities).map(([key, field]) => [
        key,
        normalizeField(field)
      ])) as IntentDraft["entities"];

      return {
        ...(parsed.data.primaryGoal === undefined ? {} : { primaryGoal: parsed.data.primaryGoal }),
        subGoals: parsed.data.subGoals ?? [],
        entities,
        constraints: parsed.data.constraints,
        preferences: parsed.data.preferences,
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

function normalizeField(field: ExtractedField): IntentField {
  const source: IntentValueSource = field.source ?? "model_inference";
  return {
    value: field.value,
    source,
    confidence: field.confidence ?? (source === "user_explicit" ? 1 : 0.7),
    evidenceRefs: field.evidenceRefs ?? [],
    requiresConfirmation: field.requiresConfirmation ?? source === "model_inference"
  };
}

function deterministicExtraction(text: string): z.input<typeof IntentExtractionSchema> {
  const normalized = text.trim();
  const isApplication = /投|申请|应聘|投递/u.test(normalized);
  const isSubmit = /提交|直接投/u.test(normalized) && !/提交前.*确认|确认.*提交/u.test(normalized);
  const primaryGoal = isApplication
    ? (isSubmit ? "submit_application" : "prepare_application")
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
