import { z } from "zod";
import { ChallengeDiagnosticSchema, DomBoundarySchema } from "./browser-diagnostics.js";

const IdentifierSchema = z.string().min(1).max(256);
const ShortTextSchema = z.string().min(1).max(2_000);
const ContentHashSchema = z.string().min(1).max(256);
const HttpUrlSchema = z.string().url().max(4_096);

export const JobMatchSessionStateSchema = z.enum([
  "created",
  "awaiting_filter_confirmation",
  "opening_job_page",
  "awaiting_login",
  "applying_filters",
  "extracting_jobs",
  "matching_jobs",
  "awaiting_job_selection",
  "selected",
  "converted_to_application",
  "awaiting_challenge",
  "paused",
  "failed",
  "cancelled",
  "expired"
]);

export const JobEntryKindSchema = z.enum([
  "job_list",
  "job_detail",
  "application_form"
]);

export const JobSourceSchema = z.enum(["moka", "dji"]);

export const JobExpectationCriterionKindSchema = z.enum([
  "target_role",
  "location",
  "employment_type",
  "industry",
  "work_mode",
  "salary"
]);

export const JobExpectationCriterionSchema = z.object({
  kind: JobExpectationCriterionKindSchema,
  values: z.array(ShortTextSchema).min(1).max(50),
  strength: z.enum(["required", "preferred"])
}).strict();

export const JobExpectationSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  criteria: z.array(JobExpectationCriterionSchema).max(100),
  confirmedAt: z.string().datetime()
}).strict();

export const JobRequirementCategorySchema = z.enum([
  "skill",
  "responsibility",
  "project",
  "education",
  "major",
  "experience_years",
  "location",
  "employment_type",
  "industry",
  "work_mode",
  "salary",
  "other"
]);

export const JobRequirementSchema = z.object({
  id: IdentifierSchema,
  category: JobRequirementCategorySchema,
  normalizedValue: ShortTextSchema,
  required: z.boolean(),
  sourceEvidence: z.string().min(1).max(2_000)
}).strict();

const JobPostingBaseSchema = z.object({
  source: JobSourceSchema,
  sourceJobId: IdentifierSchema.optional(),
  canonicalUrl: HttpUrlSchema,
  title: ShortTextSchema,
  organization: ShortTextSchema,
  location: ShortTextSchema.optional(),
  employmentType: ShortTextSchema.optional(),
  description: z.string().min(1).max(50_000),
  requirements: z.array(JobRequirementSchema).max(500),
  adapterVersion: IdentifierSchema
}).strict();

export const JobPostingDraftSchema = JobPostingBaseSchema;

export const JobPostingSchema = JobPostingBaseSchema.extend({
  id: IdentifierSchema,
  contentHash: ContentHashSchema,
  extractedAt: z.string().datetime()
}).strict();

export const RequirementOutcomeSchema = z.enum(["satisfied", "conflict", "unknown"]);

export const RequirementAssessmentSchema = z.object({
  requirementId: IdentifierSchema,
  outcome: RequirementOutcomeSchema,
  reasonCode: z.string().min(1).max(128)
}).strict();

export const MatchEvidenceSourceSchema = z.enum([
  "confirmed_fact",
  "normalized_fact",
  "trigram",
  "dense"
]);

export const MatchEvidenceSchema = z.object({
  requirementId: IdentifierSchema,
  evidenceId: IdentifierSchema,
  source: MatchEvidenceSourceSchema,
  quality: z.number().min(0).max(1),
  summary: z.string().min(1).max(2_000)
}).strict();

export const MatchGapSchema = z.object({
  requirementId: IdentifierSchema,
  outcome: RequirementOutcomeSchema,
  summary: z.string().min(1).max(2_000)
}).strict();

export const ScoringVersionSchema = z.literal("job-match-v1");

const ScoreSchema = z.number().min(0).max(100);

export const JobMatchResultSchema = z.object({
  id: IdentifierSchema,
  version: z.number().int().nonnegative(),
  sessionId: IdentifierSchema,
  postingId: IdentifierSchema,
  fitScore: ScoreSchema,
  confidence: ScoreSchema,
  rankingScore: ScoreSchema,
  outcomes: z.array(RequirementAssessmentSchema).max(500),
  evidence: z.array(MatchEvidenceSchema).max(1_500),
  gaps: z.array(MatchGapSchema).max(500),
  scoringVersion: ScoringVersionSchema,
  profileRevision: z.number().int().nonnegative(),
  expectationRevision: z.number().int().nonnegative(),
  postingContentHash: ContentHashSchema,
  stale: z.boolean()
}).strict();

export const JobFilterStateSchema = z.object({
  key: z.string().min(1).max(128),
  values: z.array(ShortTextSchema).max(50)
}).strict();

export const JobCardSnapshotSchema = z.object({
  sourceJobId: IdentifierSchema.optional(),
  canonicalUrl: HttpUrlSchema,
  title: ShortTextSchema,
  organization: ShortTextSchema,
  location: ShortTextSchema.optional(),
  summary: z.string().max(2_000).optional()
}).strict();

export const JobPaginationSnapshotSchema = z.object({
  kind: z.enum(["page", "cursor", "infinite_scroll", "none"]),
  current: z.number().int().nonnegative().optional(),
  hasNext: z.boolean(),
  nextCursor: z.string().min(1).max(1_024).optional()
}).strict();

export const JobPageSnapshotSchema = z.object({
  id: IdentifierSchema,
  ownerId: IdentifierSchema,
  url: HttpUrlSchema,
  title: z.string().max(2_000),
  capturedAt: z.string().datetime(),
  entryHint: z.enum(["job_list", "job_detail", "application_form", "login", "unknown"]),
  visibleText: z.array(z.string().max(2_000)).max(500),
  jobCards: z.array(JobCardSnapshotSchema).max(2_000),
  filterState: z.array(JobFilterStateSchema).max(100),
  pagination: JobPaginationSnapshotSchema,
  boundaries: z.array(DomBoundarySchema).max(50),
  challenge: ChallengeDiagnosticSchema.optional()
}).strict();

export const MappedJobFilterSchema = z.object({
  criterionIndex: z.number().int().nonnegative(),
  key: z.string().min(1).max(128),
  values: z.array(ShortTextSchema).min(1).max(50)
}).strict();

export const LocalJobCriterionSchema = z.object({
  criterionIndex: z.number().int().nonnegative(),
  reasonCode: z.string().min(1).max(128)
}).strict();

export const FilterPlanSchema = z.object({
  source: JobSourceSchema,
  adapterVersion: IdentifierSchema,
  mapped: z.array(MappedJobFilterSchema).max(100),
  localOnly: z.array(LocalJobCriterionSchema).max(100)
}).strict();

export const ExtractedJobPageSchema = z.object({
  postings: z.array(JobPostingDraftSchema).max(2_000),
  nextCursor: z.string().min(1).max(1_024).optional(),
  hasNext: z.boolean()
}).strict();

export const JobMatchMutationGuardSchema = z.object({
  sessionVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(128)
}).strict();

export const JobSelectionInputSchema = JobMatchMutationGuardSchema.extend({
  resultId: IdentifierSchema,
  resultVersion: z.number().int().nonnegative(),
  postingContentHash: ContentHashSchema
}).strict();

export const ConflictJobSelectionInputSchema = JobSelectionInputSchema.extend({
  conflictSummaryHash: ContentHashSchema
}).strict();

export type JobMatchSessionState = z.infer<typeof JobMatchSessionStateSchema>;
export type JobEntryKind = z.infer<typeof JobEntryKindSchema>;
export type JobSource = z.infer<typeof JobSourceSchema>;
export type JobExpectationCriterion = z.infer<typeof JobExpectationCriterionSchema>;
export type JobExpectationSnapshot = z.infer<typeof JobExpectationSnapshotSchema>;
export type JobRequirement = z.infer<typeof JobRequirementSchema>;
export type JobPostingDraft = z.infer<typeof JobPostingDraftSchema>;
export type JobPosting = z.infer<typeof JobPostingSchema>;
export type RequirementOutcome = z.infer<typeof RequirementOutcomeSchema>;
export type RequirementAssessment = z.infer<typeof RequirementAssessmentSchema>;
export type MatchEvidence = z.infer<typeof MatchEvidenceSchema>;
export type MatchGap = z.infer<typeof MatchGapSchema>;
export type JobMatchResult = z.infer<typeof JobMatchResultSchema>;
export type JobPageSnapshot = z.infer<typeof JobPageSnapshotSchema>;
export type FilterPlan = z.infer<typeof FilterPlanSchema>;
export type ExtractedJobPage = z.infer<typeof ExtractedJobPageSchema>;
export type JobMatchMutationGuard = z.infer<typeof JobMatchMutationGuardSchema>;
export type JobSelectionInput = z.infer<typeof JobSelectionInputSchema>;
export type ConflictJobSelectionInput = z.infer<typeof ConflictJobSelectionInputSchema>;
