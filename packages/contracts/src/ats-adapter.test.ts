import { describe, expect, it } from "vitest";
import {
  AdapterReviewSummarySchema,
  AiHintPackProposalSchema,
  AiReplayReviewSchema,
  CertifiedHintPackSchema,
  HintPackDefinitionSchema,
  HumanCertificationDecisionSchema,
  ReplayReportSchema
} from "./ats-adapter.js";

const hash = (character: string) => character.repeat(64);

const definition = {
  schemaVersion: 1 as const,
  packId: "mokahr-cn",
  version: "1.0.0",
  match: {
    sites: [{ hostSuffix: "mokahr.com", pathPrefixes: ["/"] }],
    stages: ["application_form"],
    requiredTextSignals: ["education"],
    pageFingerprintHashes: [hash("a")]
  },
  sectionRules: [{
    section: "education",
    headingAliases: ["Education"],
    fieldOrderAliases: [["School", "Major"]]
  }],
  fieldRules: [{
    ruleId: "school",
    profilePath: "education[0].institution",
    labelAliases: ["School"],
    sections: ["education"],
    controlTypes: ["text"],
    confidence: 1
  }],
  actionRules: [{
    kind: "add_repeated_entry",
    verbs: ["Add"],
    sections: ["education", "laboratory"]
  }],
  fixtures: [{ fixtureId: "mokahr-basic", expectedProfilePaths: ["education[0].institution"] }]
};

const proposal = {
  proposalId: "proposal-1",
  taskId: "task-1",
  lifecycleStatus: "candidate" as const,
  provider: "deepseek",
  model: "deepseek-v4-flash",
  promptVersion: "hint-proposal-v1" as const,
  inputHash: hash("a"),
  outputHash: hash("b"),
  definition,
  unsupportedBoundaries: [],
  rejectedActions: ["terminal_submit"],
  createdAt: "2026-08-17T00:00:00.000Z"
};

const replayReport = {
  reportId: "report-1",
  proposalId: proposal.proposalId,
  fixtureId: "mokahr-basic",
  status: "passed" as const,
  assertions: [{ code: "zero_submit" as const, passed: true, detail: "No terminal submission occurred." }],
  submissionCount: 0,
  inputHash: hash("c"),
  createdAt: "2026-08-17T00:01:00.000Z"
};

describe("ATS adapter contracts", () => {
  it("keeps AI output candidate-only, selector-free, and non-executable", () => {
    const parsed = AiHintPackProposalSchema.parse(proposal);

    expect(parsed.lifecycleStatus).toBe("candidate");
    expect(AiHintPackProposalSchema.safeParse({ ...proposal, lifecycleStatus: "certified" }).success).toBe(false);
    expect(AiHintPackProposalSchema.safeParse({ ...proposal, selector: "#application" }).success).toBe(false);
    expect(AiHintPackProposalSchema.safeParse({ ...proposal, executableCommand: { type: "fill" } }).success).toBe(false);
    expect(AiHintPackProposalSchema.safeParse({ ...proposal, nodeRef: { nodeId: "node" } }).success).toBe(false);
    expect(AiHintPackProposalSchema.safeParse({
      ...proposal,
      definition: {
        ...definition,
        fieldRules: [{ ...definition.fieldRules[0], selector: "#school" }]
      }
    }).success).toBe(false);
  });

  it("keeps host and path matching coupled and supports laboratory repeat semantics", () => {
    expect(HintPackDefinitionSchema.parse(definition).match.sites).toEqual([
      { hostSuffix: "mokahr.com", pathPrefixes: ["/"] }
    ]);
    expect(HintPackDefinitionSchema.parse({
      ...definition,
      fieldRules: []
    }).actionRules[0]?.sections).toContain("laboratory");
    expect(HintPackDefinitionSchema.safeParse({
      ...definition,
      match: { ...definition.match, hostSuffixes: ["mokahr.com"] }
    }).success).toBe(false);
  });

  it("requires replay and human provenance for a certified pack", () => {
    expect(CertifiedHintPackSchema.safeParse({
      ...definition,
      lifecycleStatus: "certified"
    }).success).toBe(false);

    expect(CertifiedHintPackSchema.parse({
      ...definition,
      lifecycleStatus: "certified",
      certifiedAt: "2026-08-17T00:02:00.000Z",
      provenance: {
        proposalId: proposal.proposalId,
        replayReportIds: [replayReport.reportId],
        humanReviewId: "human-1"
      }
    }).provenance.replayReportIds).toEqual([replayReport.reportId]);
  });

  it("keeps failed replay evidence but requires passed replays to be internally safe", () => {
    expect(ReplayReportSchema.parse({
      ...replayReport,
      status: "failed",
      assertions: [{ code: "zero_submit", passed: false, detail: "Unexpected submit was recorded." }],
      submissionCount: 1
    }).submissionCount).toBe(1);
    expect(ReplayReportSchema.safeParse({
      ...replayReport,
      assertions: [{ code: "zero_submit", passed: false, detail: "Unexpected submit was recorded." }]
    }).success).toBe(false);
    expect(ReplayReportSchema.safeParse({ ...replayReport, submissionCount: 1 }).success).toBe(false);
  });

  it("requires acknowledgement on the AI-unavailable certification path", () => {
    expect(HumanCertificationDecisionSchema.safeParse({
      reviewId: "human-1",
      proposalId: proposal.proposalId,
      decision: "certify",
      reviewer: "local-user",
      aiReviewUnavailable: true,
      acknowledgedAiUnavailable: false,
      createdAt: "2026-08-17T00:03:00.000Z"
    }).success).toBe(false);
    expect(HumanCertificationDecisionSchema.parse({
      reviewId: "human-1",
      proposalId: proposal.proposalId,
      decision: "certify",
      reviewer: "local-user",
      aiReviewUnavailable: true,
      acknowledgedAiUnavailable: true,
      createdAt: "2026-08-17T00:03:00.000Z"
    }).acknowledgedAiUnavailable).toBe(true);
  });

  it("keeps AI replay review structured and review summaries write-blocked", () => {
    const aiReview = AiReplayReviewSchema.parse({
      reviewId: "ai-1",
      proposalId: proposal.proposalId,
      reportId: replayReport.reportId,
      recommendation: "accept_for_human_review",
      findings: [{ code: "safe", severity: "info", explanation: "All hard assertions passed." }],
      provider: "deepseek",
      model: "deepseek-v4-flash",
      promptVersion: "replay-review-v1",
      inputHash: hash("d"),
      outputHash: hash("e"),
      createdAt: "2026-08-17T00:04:00.000Z"
    });

    expect(AiReplayReviewSchema.safeParse({ ...aiReview, rawResponse: "unredacted" }).success).toBe(false);
    expect(AdapterReviewSummarySchema.parse({
      proposal,
      replayReports: [replayReport],
      aiReview,
      lifecycleStatus: "ai_reviewed",
      aiReviewUnavailable: false,
      writeBlocked: true
    }).writeBlocked).toBe(true);
    expect(AdapterReviewSummarySchema.safeParse({
      proposal,
      replayReports: [replayReport],
      aiReview,
      lifecycleStatus: "ai_reviewed",
      aiReviewUnavailable: false,
      writeBlocked: false
    }).success).toBe(false);
  });
});
