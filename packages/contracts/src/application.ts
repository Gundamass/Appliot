import { z } from "zod";
import { EvidenceSchema, JsonValueSchema } from "./profile.js";
import { ApplicationTaskNameSchema } from "./application-name.js";

export const ApplicationTaskStateSchema = z.enum([
  "created",
  "observing_page",
  "waiting_for_login",
  "needs_questions",
  "awaiting_content_review",
  "filling",
  "validating",
  "navigating",
  "review_locked",
  "cancelled",
  "failed"
]);

export const ApplicationDisplayPhaseSchema = z.enum([
  "deterministic_fill",
  "semantic_fill",
  "dynamic_validation",
  "review_handoff"
]);

export const ApplicationTaskInputSchema = z.object({
  applicationUrl: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }),
  name: ApplicationTaskNameSchema.optional()
}).strict();

export const ApplicationAnswerSchema = z.object({
  id: z.string().min(1).max(128),
  value: JsonValueSchema,
  scope: z.literal("application").default("application"),
  promoteToProfile: z.boolean().default(false)
}).strict();

export const ApplicationQuestionSchema = z.object({
  id: z.string().min(1).max(128),
  fieldId: z.string().min(1).max(128),
  fieldPath: z.string().min(1).max(512).optional(),
  label: z.string().min(1).max(500).optional(),
  text: z.string().min(1).max(2_000),
  pageText: z.string().min(1).max(2_000).default("页面未提供明确字段文案"),
  interpretation: z.string().min(1).max(2_000).default("系统已识别该字段，但尚无可安全填写的已确认资料"),
  missingInformation: z.string().min(1).max(2_000).default("缺少完成当前字段所需的信息"),
  scope: z.literal("application").default("application"),
  inputType: z.enum(["text", "textarea", "select", "checkbox", "date"]).default("text"),
  options: z.array(z.string().max(2_000)).max(500).default([]),
  required: z.boolean().default(false)
}).strict();

export const ApplicationCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cancel") }).strict(),
  z.object({ type: z.literal("open_browser") }).strict(),
  z.object({ type: z.literal("resume") }).strict(),
  z.object({ type: z.literal("resume_with_profile") }).strict(),
  z.object({ type: z.literal("sync_profile") }).strict(),
  z.object({ type: z.literal("answer_questions"), answers: z.array(ApplicationAnswerSchema).min(1).max(100) }).strict(),
  z.object({ type: z.literal("approve_content"), reviewId: z.string().min(1).max(128), editedValue: z.string().min(1).max(12_000).optional() }).strict(),
  z.object({ type: z.literal("reject_content"), reviewId: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal("promote_answer_to_profile"), answerId: z.string().min(1).max(128) }).strict()
]);

export const ApplicationCommandTypeSchema = z.enum([
  "cancel",
  "open_browser",
  "resume",
  "resume_with_profile",
  "sync_profile",
  "answer_questions",
  "approve_content",
  "reject_content",
  "promote_answer_to_profile"
]);

export const ApplicationRecoveryCommandSchema = z.enum([
  "retry_current",
  "manual_done",
  "cancel"
]);

export const ApplicationContentReviewSchema = z.object({
  id: z.string().min(1).max(128),
  fieldId: z.string().min(1).max(128),
  fieldLabel: z.string().min(1).max(500).default("待审核内容"),
  original: z.string().max(12_000).default(""),
  draft: z.string().max(12_000),
  reasons: z.array(z.string().min(1).max(1_000)).max(12).default([]),
  evidence: z.array(EvidenceSchema).max(50).default([]),
  unsupportedClaims: z.array(z.string().min(1).max(500)).max(50).default([]),
  status: z.enum(["needs_review", "approved", "blocked"]).default("needs_review")
}).strict().superRefine((review, context) => {
  if (review.unsupportedClaims.length > 0 && review.status !== "blocked") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "存在无证据支持的陈述时，内容评审必须保持阻断状态"
    });
  }
});

export const ApplicationTaskAnswerSchema = z.object({
  id: z.string().min(1).max(128),
  fieldPath: z.string().min(1).max(512),
  value: JsonValueSchema
}).strict();

export const ApplicationFieldAssessmentSchema = z.object({
  fieldId: z.string().min(1).max(128),
  label: z.string().min(1).max(500),
  semantic: z.string().min(1).max(512).optional(),
  status: z.enum(["ready", "review", "missing", "unsupported", "filled"]),
  source: z.enum(["dji_catalog", "exact", "semantic", "user", "none"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(2_000),
  evidence: z.array(EvidenceSchema).max(50)
}).strict();

export const ApplicationFieldCoverageSchema = z.object({
  total: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  filled: z.number().int().nonnegative(),
  fields: z.array(ApplicationFieldAssessmentSchema).max(500)
}).strict();

export const ApplicationTaskSchema = z.object({
  id: z.string().uuid(),
  applicationUrl: ApplicationTaskInputSchema.shape.applicationUrl,
  name: ApplicationTaskNameSchema.optional(),
  state: ApplicationTaskStateSchema,
  commands: z.array(ApplicationCommandTypeSchema),
  recoveryCommands: z.array(ApplicationRecoveryCommandSchema).default([]),
  questions: z.array(ApplicationQuestionSchema).default([]),
  taskAnswers: z.array(ApplicationTaskAnswerSchema).default([]),
  profileRevisionApplied: z.number().int().nonnegative().optional(),
  profileSyncStatus: z.enum(["current", "pending", "failed"]).optional(),
  profileSyncError: z.string().min(1).max(200).optional(),
  fieldCoverage: ApplicationFieldCoverageSchema.optional(),
  contentReview: ApplicationContentReviewSchema.optional()
}).strict();

export const ApplicationActivityKindSchema = z.enum([
  "page_changed",
  "page_stable",
  "user_activity",
  "worker_connected",
  "worker_disconnected"
]);

export const ApplicationOperationKindSchema = z.enum([
  "observe",
  "fill",
  "select",
  "upload",
  "validate",
  "navigate"
]);

export const ApplicationOperationStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "timed_out"
]);

export const ApplicationDisplayCategorySchema = z.enum([
  "当前字段",
  "个人信息",
  "联系方式",
  "教育经历",
  "工作经历",
  "项目经历",
  "求职信息",
  "附件",
  "页面状态",
  "浏览器状态"
]);

export const ApplicationOperationErrorCodeSchema = z.enum([
  "TIMEOUT",
  "FIELD_NOT_FOUND",
  "READBACK_MISMATCH",
  "VALIDATION_FAILED",
  "PAGE_ERROR",
  "PAGE_UNSTABLE",
  "WORKER_DISCONNECTED"
]);

export const ApplicationTaskProgressSchema = z.object({
  current: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  phase: ApplicationTaskStateSchema,
  displayPhase: ApplicationDisplayPhaseSchema.optional(),
  fieldId: z.string().min(1).max(128),
  displayCategory: ApplicationDisplayCategorySchema
}).strict().superRefine((progress, context) => {
  if (progress.current > progress.total) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["current"],
      message: "当前进度不能超过总数"
    });
  }
});

export const ApplicationTaskOperationSchema = z.object({
  kind: ApplicationOperationKindSchema,
  status: ApplicationOperationStatusSchema,
  elapsedMs: z.number().int().nonnegative(),
  timeoutMs: z.number().int().positive(),
  errorCode: ApplicationOperationErrorCodeSchema.optional()
}).strict();

export const ApplicationActivitySchema = z.object({
  kind: ApplicationActivityKindSchema,
  fieldId: z.string().min(1).max(128).optional(),
  displayCategory: ApplicationDisplayCategorySchema
}).strict();

const ApplicationTaskEventBaseShape = {
  id: z.string().regex(/^\d+$/),
  taskId: z.string().uuid(),
  createdAt: z.string().datetime()
};

export const ApplicationTaskStateChangedEventSchema = z.object({
  ...ApplicationTaskEventBaseShape,
  type: z.literal("state_changed"),
  state: ApplicationTaskStateSchema
}).strict();

export const ApplicationTaskEventSchema = z.discriminatedUnion("type", [
  ApplicationTaskStateChangedEventSchema,
  z.object({
    ...ApplicationTaskEventBaseShape,
    type: z.literal("browser_activity"),
    activity: ApplicationActivitySchema
  }).strict(),
  z.object({
    ...ApplicationTaskEventBaseShape,
    type: z.literal("operation_started"),
    progress: ApplicationTaskProgressSchema,
    operation: ApplicationTaskOperationSchema
  }).strict(),
  z.object({
    ...ApplicationTaskEventBaseShape,
    type: z.literal("operation_completed"),
    progress: ApplicationTaskProgressSchema,
    operation: ApplicationTaskOperationSchema
  }).strict(),
  z.object({
    ...ApplicationTaskEventBaseShape,
    type: z.literal("operation_failed"),
    progress: ApplicationTaskProgressSchema,
    operation: ApplicationTaskOperationSchema
  }).strict(),
  z.object({
    ...ApplicationTaskEventBaseShape,
    type: z.literal("task_paused"),
    activity: ApplicationActivitySchema
  }).strict(),
  z.object({
    ...ApplicationTaskEventBaseShape,
    type: z.literal("task_resumed"),
    activity: ApplicationActivitySchema
  }).strict()
]);

export const ApplicationTaskHistoryResetSchema = z.object({
  type: z.literal("history_reset"),
  taskId: z.string().uuid(),
  reason: z.literal("history_gap"),
  requestedLastEventId: z.string().regex(/^\d+$/),
  oldestAvailableId: z.string().regex(/^\d+$/)
}).strict();

export type ApplicationTaskState = z.infer<typeof ApplicationTaskStateSchema>;
export type ApplicationDisplayPhase = z.infer<typeof ApplicationDisplayPhaseSchema>;
export type ApplicationTaskInput = z.infer<typeof ApplicationTaskInputSchema>;
export type ApplicationAnswer = z.infer<typeof ApplicationAnswerSchema>;
export type ApplicationQuestion = z.infer<typeof ApplicationQuestionSchema>;
export type ApplicationCommand = z.infer<typeof ApplicationCommandSchema>;
export type ApplicationCommandType = z.infer<typeof ApplicationCommandTypeSchema>;
export type ApplicationRecoveryCommand = z.infer<typeof ApplicationRecoveryCommandSchema>;
export type ApplicationContentReview = z.infer<typeof ApplicationContentReviewSchema>;
export type ApplicationTaskAnswer = z.infer<typeof ApplicationTaskAnswerSchema>;
export type ApplicationFieldAssessment = z.infer<typeof ApplicationFieldAssessmentSchema>;
export type ApplicationFieldCoverage = z.infer<typeof ApplicationFieldCoverageSchema>;
export type ApplicationTask = z.infer<typeof ApplicationTaskSchema>;
export type ActivityKind = z.infer<typeof ApplicationActivityKindSchema>;
export type OperationKind = z.infer<typeof ApplicationOperationKindSchema>;
export type OperationStatus = z.infer<typeof ApplicationOperationStatusSchema>;
export type ApplicationDisplayCategory = z.infer<typeof ApplicationDisplayCategorySchema>;
export type ApplicationOperationErrorCode = z.infer<typeof ApplicationOperationErrorCodeSchema>;
export type ApplicationTaskProgress = z.infer<typeof ApplicationTaskProgressSchema>;
export type ApplicationTaskOperation = z.infer<typeof ApplicationTaskOperationSchema>;
export type ApplicationActivity = z.infer<typeof ApplicationActivitySchema>;
export type ApplicationTaskProgressEvent = z.infer<typeof ApplicationTaskEventSchema>;
export type ApplicationTaskEvent = z.infer<typeof ApplicationTaskStateChangedEventSchema>;
export type ApplicationTaskHistoryReset = z.infer<typeof ApplicationTaskHistoryResetSchema>;
