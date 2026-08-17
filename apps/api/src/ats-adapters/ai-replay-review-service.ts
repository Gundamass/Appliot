import { createHash, randomUUID } from "node:crypto";
import {
  AiReplayReviewSchema,
  ReplayReportSchema,
  type AiHintPackProposal,
  type AiReplayReview,
  type HintPackDefinition,
  type ReplayReport
} from "@resume/contracts";
import { certifiedTextReference } from "@resume/form-semantics";
import type { StructuredModelProvider } from "@resume/model-provider";
import type { AdapterLedger } from "./adapter-ledger.js";

const REPLAY_REVIEW_PROMPT_VERSION = "replay-review-v1" as const;
const TEXT_REFERENCE_PATTERN = /^ats:sha256:[1-9]\d{0,2}:[a-f0-9]{64}$/u;

export type AiReplayReviewResult =
  | { kind: "reviewed"; lifecycleStatus: "ai_reviewed"; review: AiReplayReview }
  | { kind: "unavailable"; lifecycleStatus: "replay_verified" };

export interface AiReplayReviewService {
  review(proposal: AiHintPackProposal, report: ReplayReport): Promise<AiReplayReviewResult>;
}

export interface AiReplayReviewServiceDependencies {
  provider: StructuredModelProvider;
  ledger: Pick<AdapterLedger, "recordAiReview" | "findReviewSummary">;
  providerName: string;
  model: string;
  now?: () => Date;
  createId?: () => string;
}

export function createAiReplayReviewService(
  dependencies: AiReplayReviewServiceDependencies
): AiReplayReviewService {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;

  return {
    async review(proposal, report) {
      const parsedReport = ReplayReportSchema.safeParse(report);
      if (!parsedReport.success) throw new Error("hard_gate_failed");
      const verifiedReport = parsedReport.data;
      if (verifiedReport.status !== "passed" || verifiedReport.assertions.some((assertion) => !assertion.passed)) {
        throw new Error("hard_gate_failed");
      }

      const definition = sanitizeDefinition(proposal.definition);
      const replay = sanitizeReplayReport(verifiedReport);
      const inputHash = hash({ definition, replay });
      let modelReview: AiReplayReview;
      try {
        modelReview = await dependencies.provider.generateStructured({
          system: [
            "Review a deterministic ATS replay result for human certification only.",
            "Do not override deterministic gates and do not generate browser commands, selectors, scripts, requests, profile values, or submission actions.",
            "Return only the required JSON review shape."
          ].join(" "),
          user: JSON.stringify({ definition, replay }),
          schema: AiReplayReviewSchema,
          jsonExample: reviewExample(proposal.proposalId, verifiedReport.reportId, dependencies.providerName, dependencies.model),
          metadata: { requestId: proposal.proposalId, purpose: "adapter_replay_review" }
        });
      } catch {
        return { kind: "unavailable", lifecycleStatus: "replay_verified" };
      }

      const review = AiReplayReviewSchema.parse({
        reviewId: createId(),
        proposalId: proposal.proposalId,
        reportId: verifiedReport.reportId,
        recommendation: modelReview.recommendation,
        findings: modelReview.findings,
        provider: dependencies.providerName,
        model: dependencies.model,
        promptVersion: REPLAY_REVIEW_PROMPT_VERSION,
        inputHash,
        outputHash: hash(modelReview),
        createdAt: now().toISOString()
      });
      dependencies.ledger.recordAiReview(review);
      const persisted = dependencies.ledger.findReviewSummary(proposal.proposalId)?.aiReview;
      if (persisted === undefined) throw new Error("adapter_ai_review_persistence_failed");
      return { kind: "reviewed", lifecycleStatus: "ai_reviewed", review: persisted };
    }
  };
}

function sanitizeDefinition(definition: HintPackDefinition): HintPackDefinition {
  return {
    ...definition,
    match: {
      ...definition.match,
      requiredTextSignals: definition.match.requiredTextSignals.map(textReference)
    },
    sectionRules: definition.sectionRules.map((rule) => ({
      ...rule,
      headingAliases: rule.headingAliases.map(textReference),
      fieldOrderAliases: rule.fieldOrderAliases.map((aliases) => aliases.map(textReference))
    })),
    fieldRules: definition.fieldRules.map((rule) => ({
      ...rule,
      labelAliases: rule.labelAliases.map(textReference)
    })),
    actionRules: definition.actionRules.map((rule) => ({
      ...rule,
      verbs: rule.verbs.map(textReference)
    }))
  };
}

function sanitizeReplayReport(report: ReplayReport) {
  return {
    status: report.status,
    submissionCount: report.submissionCount,
    assertions: report.assertions.map(({ code, passed }) => ({ code, passed }))
  };
}

function textReference(value: string): string {
  return TEXT_REFERENCE_PATTERN.test(value) ? value : certifiedTextReference(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function reviewExample(proposalId: string, reportId: string, provider: string, model: string): AiReplayReview {
  return {
    reviewId: "review-example",
    proposalId,
    reportId,
    recommendation: "accept_for_human_review",
    findings: [],
    provider,
    model,
    promptVersion: REPLAY_REVIEW_PROMPT_VERSION,
    inputHash: "0".repeat(64),
    outputHash: "0".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}
