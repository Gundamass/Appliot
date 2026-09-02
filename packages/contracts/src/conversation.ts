import { z } from "zod";
import {
  RecruitmentCompanySchema,
  RecruitmentSearchRequestSchema,
  RecruitmentSearchTypeSchema,
  RecruitmentSiteCandidateSchema,
  VerifiedRecruitmentSiteSchema
} from "./recruitment-search.js";
import {
  JobExpectationSnapshotSchema,
  JobMatchSessionStateSchema
} from "./job-matching.js";

const IdentifierSchema = z.string().min(1).max(256);
const TimestampSchema = z.string().datetime({ offset: true });

export const ConversationIntentKindSchema = z.enum([
  "list_recommendations",
  "show_recommendation",
  "start_application",
  "show_application_task",
  "list_application_tasks",
  "start_application_and_show_status",
  "discover_recruitment_site",
  "request_job_recommendations",
  "help",
  "unknown"
]);

export const ConversationTargetKindSchema = z.enum([
  "recommendation",
  "task",
  "job_match_session",
  "recruitment_site"
]);

export const ConversationTargetSchema = z.object({
  kind: ConversationTargetKindSchema,
  id: IdentifierSchema.optional(),
  ordinal: z.number().int().positive().max(100).optional(),
  company: RecruitmentCompanySchema.optional(),
  recruitmentType: RecruitmentSearchTypeSchema.optional()
}).strict().superRefine((target, context) => {
  const hasRecruitmentFields = target.company !== undefined || target.recruitmentType !== undefined;
  if (target.kind === "recruitment_site" && (target.company === undefined || target.recruitmentType === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["company"], message: "recruitment_company_required" });
  }
  if (target.kind !== "recruitment_site" && hasRecruitmentFields) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["company"], message: "recruitment_fields_not_allowed" });
  }
});

export const ConversationIntentSchema = z.object({
  kind: ConversationIntentKindSchema,
  target: ConversationTargetSchema.optional(),
  requiresConfirmation: z.boolean().default(false)
}).strict();

const RecommendationCardSchema = z.object({
  type: z.literal("recommendation"),
  sessionId: IdentifierSchema,
  resultId: IdentifierSchema,
  title: z.string().max(160),
  company: z.string().max(160),
  score: z.number().min(0).max(100),
  evidenceCount: z.number().int().nonnegative(),
  postingContentHash: z.string().max(256).optional()
}).strict();

const ApplicationTaskCardSchema = z.object({
  type: z.literal("application_task"),
  taskId: IdentifierSchema,
  title: z.string().max(160),
  state: z.string().min(1).max(80),
  applicationUrl: z.string().url()
}).strict();

const RecommendationConfirmationTargetSchema = z.object({
  kind: z.literal("recommendation"),
  sessionId: IdentifierSchema,
  resultId: IdentifierSchema,
  postingContentHash: z.string().max(256).optional()
}).strict();

const RecruitmentSiteChoicesTargetSchema = z.object({
  kind: z.literal("recruitment_site_choices"),
  company: RecruitmentCompanySchema,
  recruitmentType: RecruitmentSearchTypeSchema,
  query: z.string().trim().min(1).max(200),
  candidates: z.array(RecruitmentSiteCandidateSchema).min(1).max(3)
}).strict();

const RecruitmentSiteTargetSchema = z.object({
  kind: z.literal("recruitment_site"),
  ...VerifiedRecruitmentSiteSchema.shape
}).strict();

const RecruitmentSiteCardSchema = z.object({
  type: z.literal("recruitment_site"),
  ...VerifiedRecruitmentSiteSchema.shape
}).strict();

const JobMatchSessionCardSchema = z.object({
  type: z.literal("job_match_session"),
  sessionId: IdentifierSchema,
  initialUrl: z.string().url(),
  state: z.string().min(1).max(80),
  postingCount: z.number().int().nonnegative()
}).strict();

const ConfirmationCardSchema = z.object({
  type: z.literal("confirmation"),
  confirmationId: IdentifierSchema.optional(),
  action: z.enum(["start_application", "confirm_recruitment_site", "request_job_recommendations"]),
  target: z.union([
    RecommendationConfirmationTargetSchema,
    RecruitmentSiteChoicesTargetSchema,
    RecruitmentSiteTargetSchema
  ])
}).strict();

export const ConversationCardSchema = z.union([
  RecommendationCardSchema,
  ApplicationTaskCardSchema,
  RecruitmentSiteCardSchema,
  JobMatchSessionCardSchema,
  ConfirmationCardSchema
]).superRefine((card, context) => {
  if (card.type !== "confirmation") return;
  if (card.action === "start_application" && card.target.kind !== "recommendation") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target", "kind"],
      message: "start_application_target_invalid"
    });
  }
  if (card.action === "confirm_recruitment_site" && card.target.kind !== "recruitment_site_choices") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target", "kind"],
      message: "recruitment_choices_confirmation_target_invalid"
    });
  }
  if (card.action === "request_job_recommendations" && card.target.kind !== "recruitment_site") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target", "kind"],
      message: "recruitment_confirmation_target_invalid"
    });
  }
});

const StartApplicationConfirmationSchema = z.object({
  confirmationId: IdentifierSchema,
  action: z.literal("start_application"),
  sourceTurnSequence: z.number().int().positive().optional(),
  target: RecommendationConfirmationTargetSchema
}).strict();

const RecruitmentSiteChoicesConfirmationSchema = z.object({
  confirmationId: IdentifierSchema,
  action: z.literal("confirm_recruitment_site"),
  sourceTurnSequence: z.number().int().positive().optional(),
  target: RecruitmentSiteChoicesTargetSchema
}).strict();

const RecruitmentSiteConfirmationSchema = z.object({
  confirmationId: IdentifierSchema,
  action: z.literal("request_job_recommendations"),
  sourceTurnSequence: z.number().int().positive().optional(),
  target: RecruitmentSiteTargetSchema
}).strict();

export const ConversationConfirmationSchema = z.union([
  StartApplicationConfirmationSchema,
  RecruitmentSiteChoicesConfirmationSchema,
  RecruitmentSiteConfirmationSchema
]);

export const ConversationMessageRoleSchema = z.enum(["user", "assistant"]);

export const ConversationMessageSchema = z.object({
  id: IdentifierSchema,
  sessionId: IdentifierSchema,
  sequence: z.number().int().positive(),
  role: ConversationMessageRoleSchema,
  text: z.string().min(1).max(12_000),
  cards: z.array(ConversationCardSchema).max(20).default([]),
  intent: ConversationIntentSchema.optional(),
  createdAt: TimestampSchema
}).strict();

export const ConversationSessionSchema = z.object({
  id: IdentifierSchema,
  title: z.string().min(1).max(160),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
}).strict();

export const ConversationSessionListSchema = z.array(ConversationSessionSchema).max(10_000);

export const ConversationHistoryClearResultSchema = z.object({
  deletedCount: z.number().int().nonnegative()
}).strict();

export const ConversationContextSchema = z.object({
  activeJobMatchSessionId: IdentifierSchema.optional(),
  selectedPostingId: IdentifierSchema.optional(),
  activeApplicationTaskId: IdentifierSchema.optional(),
  verifiedRecruitmentSite: VerifiedRecruitmentSiteSchema.optional(),
  lastRecruitmentRequest: RecruitmentSearchRequestSchema.optional(),
  recentPostingIds: z.array(IdentifierSchema).max(50).default([]),
  lastIntent: ConversationIntentSchema.nullable().optional(),
  version: z.number().int().nonnegative()
}).strict();

const SafeNonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const SafePositiveIntegerSchema = SafeNonNegativeIntegerSchema.positive();
const ActionIdentifierSchema = IdentifierSchema.refine(
  (value) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value),
  "opaque_identifier_required"
);
const ActionIdempotencyKeySchema = z.string().trim().min(1).max(128);
const ActionContentHashSchema = z.string().trim().min(1).max(256);
const NonEmptyJobExpectationSnapshotSchema = JobExpectationSnapshotSchema.refine(
  (expectation) => expectation.criteria.length > 0,
  "job_expectation_required"
);

const ConversationJobMatchActionBaseSchema = z.object({
  conversationId: ActionIdentifierSchema,
  sessionId: ActionIdentifierSchema,
  sessionVersion: SafeNonNegativeIntegerSchema,
  idempotencyKey: ActionIdempotencyKeySchema
}).strict();

export const ConversationJobMatchActionSchema = z.discriminatedUnion("action", [
  ConversationJobMatchActionBaseSchema.extend({
    action: z.literal("confirm_filters"),
    expectation: NonEmptyJobExpectationSnapshotSchema
  }),
  ConversationJobMatchActionBaseSchema.extend({
    action: z.literal("adjust_filters"),
    expectation: NonEmptyJobExpectationSnapshotSchema
  }),
  ConversationJobMatchActionBaseSchema.extend({
    action: z.literal("pause")
  }),
  ConversationJobMatchActionBaseSchema.extend({
    action: z.literal("continue")
  }),
  ConversationJobMatchActionBaseSchema.extend({
    action: z.literal("rematch")
  }),
  ConversationJobMatchActionBaseSchema.extend({
    action: z.literal("select_result"),
    resultId: ActionIdentifierSchema,
    resultVersion: SafeNonNegativeIntegerSchema,
    postingContentHash: ActionContentHashSchema
  }),
  ConversationJobMatchActionBaseSchema.extend({
    action: z.literal("select_conflict_result"),
    resultId: ActionIdentifierSchema,
    resultVersion: SafeNonNegativeIntegerSchema,
    postingContentHash: ActionContentHashSchema,
    conflictSummaryHash: ActionContentHashSchema
  })
]);

export const ConversationProcessStageSchema = z.enum([
  "understanding_request",
  "searching_recruitment_site",
  "validating_recruitment_site",
  "recruitment_site_found",
  "waiting_for_confirmation",
  "processing_confirmation",
  "reading_recruitment_site",
  "loading_recommendations",
  "matching_jobs",
  "loading_application_progress",
  "creating_job_match_session",
  "job_match_session_ready",
  "creating_application_task",
  "generating_response",
  "completed",
  "failed"
]);

const ProcessSummarySchema = z.string().trim().min(1).max(500);
const ProcessStepIdSchema = z.string().trim().min(1).max(96)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);

export const ConversationProcessToolNameSchema = z.enum([
  "tavily_search",
  "url_guard",
  "browser_worker",
  "job_matching",
  "application_progress",
  "controlled_application"
]);

export const ConversationProcessToolSummarySchema = z.object({
  name: ConversationProcessToolNameSchema,
  input: z.array(z.object({
    label: z.string().trim().min(1).max(40),
    value: z.string().trim().min(1).max(200)
  }).strict()).max(8),
  result: ProcessSummarySchema.optional()
}).strict();

export const ConversationProcessFailureSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_]+$/u).max(64),
  summary: ProcessSummarySchema,
  retryable: z.boolean()
}).strict();

export const ConversationProcessStatusSchema = z.enum(["running", "completed", "waiting", "failed"]);

export const ConversationProcessEventSchema = z.object({
  id: z.string().regex(/^\d+$/u),
  conversationId: IdentifierSchema,
  turnSequence: z.number().int().positive(),
  stepId: ProcessStepIdSchema,
  type: z.literal("process_changed"),
  stage: ConversationProcessStageSchema,
  status: ConversationProcessStatusSchema,
  summary: ProcessSummarySchema,
  tool: ConversationProcessToolSummarySchema.optional(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  failure: ConversationProcessFailureSchema.optional(),
  createdAt: TimestampSchema
}).strict().superRefine((event, context) => {
  if (event.status === "failed" && event.failure === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["failure"], message: "process_failure_required" });
  }
  if (event.status !== "failed" && event.failure !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["failure"], message: "process_failure_unexpected" });
  }
});

export const ConversationProcessHistoryResetSchema = z.object({
  type: z.literal("history_reset"),
  conversationId: IdentifierSchema,
  reason: z.literal("history_gap"),
  requestedLastEventId: z.string().regex(/^\d+$/u),
  oldestAvailableId: z.string().regex(/^\d+$/u)
}).strict();

export const ConversationTurnInputSchema = z.object({
  text: z.string().trim().min(1).max(500)
}).strict();

const HttpsUrlSchema = z.string().url().max(2_048).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "recruitment_url_must_be_https");

export const ConversationConfirmInputSchema = z.object({
  confirmationId: IdentifierSchema,
  approved: z.boolean(),
  selectedUrl: HttpsUrlSchema.optional()
}).strict();

export const ConversationTurnResponseSchema = z.object({
  message: ConversationMessageSchema,
  cards: z.array(ConversationCardSchema).max(20).default([]),
  context: ConversationContextSchema,
  pendingConfirmation: ConversationConfirmationSchema.optional(),
  confirmationId: IdentifierSchema.optional(),
  consumedConfirmationId: IdentifierSchema.optional()
}).strict();

export const ConversationJobMatchActionResultSchema = z.object({
  sessionId: ActionIdentifierSchema,
  state: JobMatchSessionStateSchema,
  version: SafeNonNegativeIntegerSchema,
  turnSequence: SafePositiveIntegerSchema,
  message: ConversationMessageSchema,
  cards: z.array(ConversationCardSchema).max(20),
  context: ConversationContextSchema,
  applicationTaskId: ActionIdentifierSchema.optional()
}).strict();

export const ConversationViewSchema = z.object({
  session: ConversationSessionSchema,
  messages: z.array(ConversationMessageSchema).max(10_000),
  context: ConversationContextSchema,
  pendingConfirmation: ConversationConfirmationSchema.optional()
}).strict();

export type ConversationIntentKind = z.infer<typeof ConversationIntentKindSchema>;
export type ConversationTargetKind = z.infer<typeof ConversationTargetKindSchema>;
export type ConversationTarget = z.infer<typeof ConversationTargetSchema>;
export type ConversationIntent = z.infer<typeof ConversationIntentSchema>;
export type ConversationCard = z.infer<typeof ConversationCardSchema>;
export type ConversationConfirmation = z.infer<typeof ConversationConfirmationSchema>;
export type ConversationMessageRole = z.infer<typeof ConversationMessageRoleSchema>;
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
export type ConversationSession = z.infer<typeof ConversationSessionSchema>;
export type ConversationSessionList = z.infer<typeof ConversationSessionListSchema>;
export type ConversationHistoryClearResult = z.infer<typeof ConversationHistoryClearResultSchema>;
export type ConversationContext = z.infer<typeof ConversationContextSchema>;
export type ConversationJobMatchAction = z.infer<typeof ConversationJobMatchActionSchema>;
export type ConversationJobMatchActionResult = z.infer<typeof ConversationJobMatchActionResultSchema>;
export type ConversationProcessStage = z.infer<typeof ConversationProcessStageSchema>;
export type ConversationProcessStatus = z.infer<typeof ConversationProcessStatusSchema>;
export type ConversationProcessToolName = z.infer<typeof ConversationProcessToolNameSchema>;
export type ConversationProcessToolSummary = z.infer<typeof ConversationProcessToolSummarySchema>;
export type ConversationProcessFailure = z.infer<typeof ConversationProcessFailureSchema>;
export type ConversationProcessEvent = z.infer<typeof ConversationProcessEventSchema>;
export type ConversationProcessHistoryReset = z.infer<typeof ConversationProcessHistoryResetSchema>;
export type ConversationTurnInput = z.infer<typeof ConversationTurnInputSchema>;
export type ConversationConfirmInput = z.infer<typeof ConversationConfirmInputSchema>;
export type ConversationTurnResponse = z.infer<typeof ConversationTurnResponseSchema>;
export type ConversationView = z.infer<typeof ConversationViewSchema>;
