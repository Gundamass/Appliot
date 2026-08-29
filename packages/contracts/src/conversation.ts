import { z } from "zod";
import {
  RecruitmentCompanySchema,
  RecruitmentSearchRequestSchema,
  RecruitmentSearchTypeSchema,
  RecruitmentSiteCandidateSchema,
  VerifiedRecruitmentSiteSchema
} from "./recruitment-search.js";

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
  target: RecommendationConfirmationTargetSchema
}).strict();

const RecruitmentSiteChoicesConfirmationSchema = z.object({
  confirmationId: IdentifierSchema,
  action: z.literal("confirm_recruitment_site"),
  target: RecruitmentSiteChoicesTargetSchema
}).strict();

const RecruitmentSiteConfirmationSchema = z.object({
  confirmationId: IdentifierSchema,
  action: z.literal("request_job_recommendations"),
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

export const ConversationViewSchema = z.object({
  session: ConversationSessionSchema,
  messages: z.array(ConversationMessageSchema).max(10_000),
  context: ConversationContextSchema
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
export type ConversationContext = z.infer<typeof ConversationContextSchema>;
export type ConversationTurnInput = z.infer<typeof ConversationTurnInputSchema>;
export type ConversationConfirmInput = z.infer<typeof ConversationConfirmInputSchema>;
export type ConversationTurnResponse = z.infer<typeof ConversationTurnResponseSchema>;
export type ConversationView = z.infer<typeof ConversationViewSchema>;
