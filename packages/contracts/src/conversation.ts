import { z } from "zod";

const IdentifierSchema = z.string().min(1).max(256);
const TimestampSchema = z.string().datetime({ offset: true });

export const ConversationIntentKindSchema = z.enum([
  "list_recommendations",
  "show_recommendation",
  "start_application",
  "show_application_task",
  "list_application_tasks",
  "start_application_and_show_status",
  "help",
  "unknown"
]);

export const ConversationTargetKindSchema = z.enum([
  "recommendation",
  "task",
  "job_match_session"
]);

export const ConversationTargetSchema = z.object({
  kind: ConversationTargetKindSchema,
  id: IdentifierSchema.optional(),
  ordinal: z.number().int().positive().max(100).optional()
}).strict();

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

const ConfirmationTargetSchema = z.object({
  kind: z.literal("recommendation"),
  sessionId: IdentifierSchema,
  resultId: IdentifierSchema,
  postingContentHash: z.string().max(256).optional()
}).strict();

export const ConversationCardSchema = z.discriminatedUnion("type", [
  RecommendationCardSchema,
  ApplicationTaskCardSchema,
  z.object({
    type: z.literal("confirmation"),
    action: z.literal("start_application"),
    target: ConfirmationTargetSchema
  }).strict()
]);

export const ConversationConfirmationSchema = z.object({
  confirmationId: IdentifierSchema,
  action: z.literal("start_application"),
  target: ConfirmationTargetSchema
}).strict();

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
  recentPostingIds: z.array(IdentifierSchema).max(50).default([]),
  lastIntent: ConversationIntentSchema.nullable().optional(),
  version: z.number().int().nonnegative()
}).strict();

export const ConversationTurnInputSchema = z.object({
  text: z.string().trim().min(1).max(500)
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
export type ConversationTurnResponse = z.infer<typeof ConversationTurnResponseSchema>;
export type ConversationView = z.infer<typeof ConversationViewSchema>;
