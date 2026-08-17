import { z } from "zod";
import { PageSectionHintSchema } from "./browser.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/u);
const ControlTypeSchema = z.enum(["text", "textarea", "select", "radio", "checkbox", "date", "file"]);

export const HintPackRepeatSectionSchema = z.enum([
  "education",
  "work",
  "internship",
  "work_combined",
  "projects",
  "awards",
  "laboratory",
  "languages"
]);

const HintPackSectionSchema = z.union([PageSectionHintSchema, z.literal("laboratory")]);

export const HintPackLifecycleStatusSchema = z.enum([
  "candidate",
  "replay_verified",
  "ai_reviewed",
  "human_reviewed",
  "certified",
  "rejected",
  "retired"
]);

export const HintPackDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  packId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/u),
  version: SemverSchema,
  match: z.object({
    sites: z.array(z.object({
      hostSuffix: z.string().min(1).max(253),
      pathPrefixes: z.array(z.string().startsWith("/").max(500)).min(1).max(50)
    }).strict()).min(1).max(20),
    stages: z.array(z.enum(["application_form", "review"])).min(1).max(2),
    requiredTextSignals: z.array(z.string().min(1).max(80)).max(30).default([]),
    pageFingerprintHashes: z.array(Sha256Schema).max(100).default([])
  }).strict(),
  sectionRules: z.array(z.object({
    section: HintPackSectionSchema,
    headingAliases: z.array(z.string().min(1).max(80)).min(1).max(30),
    fieldOrderAliases: z.array(z.array(z.string().min(1).max(80)).min(1).max(20)).max(50)
  }).strict()).max(30),
  fieldRules: z.array(z.object({
    ruleId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/u),
    profilePath: z.string().regex(/^[a-z][a-zA-Z0-9]*(?:\[\d+\])?(?:\.[a-z][a-zA-Z0-9]*)*$/u),
    labelAliases: z.array(z.string().min(1).max(120)).min(1).max(30),
    sections: z.array(PageSectionHintSchema).max(10),
    controlTypes: z.array(ControlTypeSchema).min(1).max(7),
    confidence: z.number().min(0).max(1)
  }).strict()).max(500),
  actionRules: z.array(z.object({
    kind: z.enum(["add_repeated_entry", "intermediate_save", "intermediate_navigation"]),
    verbs: z.array(z.string().min(1).max(80)).min(1).max(20),
    sections: z.array(HintPackRepeatSectionSchema).min(1).max(20)
  }).strict()).max(50),
  fixtures: z.array(z.object({
    fixtureId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/u),
    expectedProfilePaths: z.array(z.string().min(1).max(512)).min(1).max(500)
  }).strict()).min(1).max(50)
}).strict();

export const AiHintPackProposalSchema = z.object({
  proposalId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  parentProposalId: z.string().min(1).max(128).optional(),
  lifecycleStatus: z.literal("candidate"),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  promptVersion: z.literal("hint-proposal-v1"),
  inputHash: Sha256Schema,
  outputHash: Sha256Schema,
  definition: HintPackDefinitionSchema,
  unsupportedBoundaries: z.array(z.string().min(1).max(120)).max(50),
  rejectedActions: z.array(z.enum(["unknown_side_effect", "terminal_submit"])).max(2),
  createdAt: z.string().datetime()
}).strict();

export const ReplayAssertionSchema = z.object({
  code: z.enum([
    "schema_valid",
    "policy_safe",
    "mapping_one_to_one",
    "control_type_compatible",
    "section_compatible",
    "target_value",
    "unrelated_unchanged",
    "repeat_order",
    "stable_readback",
    "boundary_paused",
    "challenge_paused",
    "zero_submit",
    "pii_free_trace"
  ]),
  passed: z.boolean(),
  detail: z.string().min(1).max(1_000)
}).strict();

export const ReplayReportSchema = z.object({
  reportId: z.string().min(1).max(128),
  proposalId: z.string().min(1).max(128),
  fixtureId: z.string().min(1).max(128),
  status: z.enum(["passed", "failed"]),
  assertions: z.array(ReplayAssertionSchema).min(1).max(1_000),
  submissionCount: z.number().int().nonnegative(),
  inputHash: Sha256Schema,
  createdAt: z.string().datetime()
}).strict().superRefine((report, context) => {
  const allAssertionsPassed = report.assertions.every((item) => item.passed);
  if ((report.status === "passed") !== allAssertionsPassed) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "status must equal deterministic assertion result"
    });
  }
  if (report.status === "passed" && report.submissionCount !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["submissionCount"],
      message: "a passed replay must record zero submissions"
    });
  }
  if (report.status === "passed" && !report.assertions.some((item) => item.code === "zero_submit" && item.passed)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["assertions"],
      message: "a passed replay must include a passing zero-submit assertion"
    });
  }
});

export const AiReplayReviewSchema = z.object({
  reviewId: z.string().min(1).max(128),
  proposalId: z.string().min(1).max(128),
  reportId: z.string().min(1).max(128),
  recommendation: z.enum(["accept_for_human_review", "revise", "reject"]),
  findings: z.array(z.object({
    code: z.string().min(1).max(80),
    severity: z.enum(["info", "warning", "error"]),
    explanation: z.string().min(1).max(1_000)
  }).strict()).max(100),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  promptVersion: z.literal("replay-review-v1"),
  inputHash: Sha256Schema,
  outputHash: Sha256Schema,
  createdAt: z.string().datetime()
}).strict();

export const HumanCertificationDecisionSchema = z.object({
  reviewId: z.string().min(1).max(128),
  proposalId: z.string().min(1).max(128),
  decision: z.enum(["certify", "reject", "revise"]),
  reviewer: z.string().min(1).max(128),
  aiReviewUnavailable: z.boolean(),
  acknowledgedAiUnavailable: z.boolean(),
  notes: z.string().max(4_000).optional(),
  createdAt: z.string().datetime()
}).strict().superRefine((decision, context) => {
  if (decision.aiReviewUnavailable && decision.decision === "certify" && !decision.acknowledgedAiUnavailable) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["acknowledgedAiUnavailable"],
      message: "acknowledge AI-unavailable certification path"
    });
  }
});

export const CertifiedHintPackSchema = HintPackDefinitionSchema.extend({
  lifecycleStatus: z.literal("certified"),
  certifiedAt: z.string().datetime(),
  provenance: z.object({
    proposalId: z.string().min(1).max(128),
    replayReportIds: z.array(z.string().min(1).max(128)).min(1).max(50),
    humanReviewId: z.string().min(1).max(128),
    aiReviewId: z.string().min(1).max(128).optional()
  }).strict()
}).strict();

export const AdapterReviewSummarySchema = z.object({
  proposal: AiHintPackProposalSchema.optional(),
  replayReports: z.array(ReplayReportSchema),
  aiReview: AiReplayReviewSchema.optional(),
  humanDecision: HumanCertificationDecisionSchema.optional(),
  lifecycleStatus: HintPackLifecycleStatusSchema,
  aiReviewUnavailable: z.boolean(),
  writeBlocked: z.literal(true)
}).strict();

export type HintPackLifecycleStatus = z.infer<typeof HintPackLifecycleStatusSchema>;
export type HintPackRepeatSection = z.infer<typeof HintPackRepeatSectionSchema>;
export type HintPackDefinition = z.infer<typeof HintPackDefinitionSchema>;
export type AiHintPackProposal = z.infer<typeof AiHintPackProposalSchema>;
export type ReplayAssertion = z.infer<typeof ReplayAssertionSchema>;
export type ReplayReport = z.infer<typeof ReplayReportSchema>;
export type AiReplayReview = z.infer<typeof AiReplayReviewSchema>;
export type HumanCertificationDecision = z.infer<typeof HumanCertificationDecisionSchema>;
export type CertifiedHintPack = z.infer<typeof CertifiedHintPackSchema>;
export type AdapterReviewSummary = z.infer<typeof AdapterReviewSummarySchema>;
