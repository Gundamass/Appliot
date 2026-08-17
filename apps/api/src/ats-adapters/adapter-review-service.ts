import { createHash, randomUUID } from "node:crypto";
import {
  AiHintPackProposalSchema,
  HintPackDefinitionSchema,
  HumanCertificationDecisionSchema,
  type AdapterReviewSummary,
  type AiHintPackProposal,
  type AiReplayReview,
  type HintPackDefinition,
  type HumanCertificationDecision,
  type ReplayReport
} from "@resume/contracts";
import type { AdapterLedger } from "./adapter-ledger.js";
import type { AiProposalService } from "./ai-proposal-service.js";
import type { AiReplayReviewResult, AiReplayReviewService } from "./ai-replay-review-service.js";
import { sanitizeAdapterObservation } from "./observation-sanitizer.js";
import type { SyntheticReplayRunner } from "./synthetic-replay-runner.js";

export interface AdapterReviewService {
  prepare(taskId: string, snapshot: import("@resume/contracts").FormSnapshot): Promise<AdapterReviewSummary>;
  get(proposalId: string): AdapterReviewSummary | undefined;
  replay(proposalId: string): Promise<AdapterReviewSummary>;
  requestAiReview(proposalId: string): Promise<AdapterReviewSummary>;
  revise(proposalId: string, definition: HintPackDefinition): Promise<AdapterReviewSummary>;
  decide(
    proposalId: string,
    input: Omit<HumanCertificationDecision, "reviewId" | "proposalId" | "reviewer" | "createdAt">
  ): AdapterReviewSummary;
  retire(packId: string, version: string, reason: string): void;
}

interface AdapterReviewServiceDependencies {
  ledger: Pick<
    AdapterLedger,
    | "findActiveByFingerprint"
    | "findProposal"
    | "findReviewSummary"
    | "createProposal"
    | "recordReplay"
    | "recordHumanDecision"
    | "certify"
    | "retire"
  >;
  aiProposalService?: Pick<AiProposalService, "propose">;
  replayRunner: Pick<SyntheticReplayRunner, "run">;
  aiReplayReviewService?: Pick<AiReplayReviewService, "review">;
  listProfilePaths(): readonly string[];
  reviewer: string;
  now?: () => Date;
  createId?: () => string;
}

export function createAdapterReviewService(
  dependencies: AdapterReviewServiceDependencies
): AdapterReviewService {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const aiUnavailable = new Set<string>();

  const get = (proposalId: string): AdapterReviewSummary | undefined => {
    const summary = dependencies.ledger.findReviewSummary(proposalId);
    if (summary === undefined) return undefined;
    return aiUnavailable.has(proposalId)
      ? { ...summary, aiReviewUnavailable: true }
      : summary;
  };

  const requireProposal = (proposalId: string): AiHintPackProposal => {
    const proposal = dependencies.ledger.findProposal(proposalId);
    if (proposal === undefined) throw new Error("adapter_proposal_not_found");
    return proposal;
  };

  const requireSummary = (proposalId: string): AdapterReviewSummary => {
    const summary = get(proposalId);
    if (summary === undefined) throw new Error("adapter_proposal_not_found");
    return summary;
  };

  return {
    async prepare(taskId, snapshot) {
      const profilePaths = dependencies.listProfilePaths();
      const inputHash = hash(sanitizeAdapterObservation(snapshot, profilePaths));
      const active = dependencies.ledger.findActiveByFingerprint(taskId, inputHash);
      if (active !== undefined) return active;

      if (dependencies.aiProposalService === undefined) {
        return {
          replayReports: [],
          lifecycleStatus: "candidate",
          aiReviewUnavailable: true,
          writeBlocked: true
        };
      }

      const proposal = await dependencies.aiProposalService.propose({ taskId, snapshot, profilePaths });
      return requireSummary(proposal.proposalId);
    },

    get,

    async replay(proposalId) {
      const proposal = requireProposal(proposalId);
      const replay = await dependencies.replayRunner.run(proposal);
      dependencies.ledger.recordReplay(replay.reports);
      aiUnavailable.delete(proposalId);
      return requireSummary(proposalId);
    },

    async requestAiReview(proposalId) {
      const proposal = requireProposal(proposalId);
      const summary = requireSummary(proposalId);
      if (summary.aiReview !== undefined) return summary;
      const report = latestPassedReplay(summary.replayReports);
      if (report === undefined) throw new Error("adapter_replay_required");
      if (dependencies.aiReplayReviewService === undefined) {
        aiUnavailable.add(proposalId);
        return requireSummary(proposalId);
      }
      const result: AiReplayReviewResult = await dependencies.aiReplayReviewService.review(proposal, report);
      if (result.kind === "unavailable") aiUnavailable.add(proposalId);
      else aiUnavailable.delete(proposalId);
      return requireSummary(proposalId);
    },

    async revise(proposalId, input) {
      const parent = requireProposal(proposalId);
      const definition = HintPackDefinitionSchema.parse({
        ...input,
        packId: parent.definition.packId,
        version: nextPatchVersion(parent.definition.version)
      });
      const proposal = AiHintPackProposalSchema.parse({
        proposalId: createId(),
        taskId: parent.taskId,
        parentProposalId: parent.proposalId,
        lifecycleStatus: "candidate",
        provider: parent.provider,
        model: parent.model,
        promptVersion: parent.promptVersion,
        inputHash: hash({ parentProposalId: parent.proposalId, definition }),
        outputHash: hash(definition),
        definition,
        unsupportedBoundaries: parent.unsupportedBoundaries,
        rejectedActions: parent.rejectedActions,
        createdAt: now().toISOString()
      });
      dependencies.ledger.createProposal(proposal);
      return requireSummary(proposal.proposalId);
    },

    decide(proposalId, input) {
      if (input.decision === "certify"
        && input.aiReviewUnavailable
        && !input.acknowledgedAiUnavailable) {
        throw new Error("adapter_transition_denied");
      }
      const decision = HumanCertificationDecisionSchema.parse({
        ...input,
        reviewId: createId(),
        proposalId,
        reviewer: dependencies.reviewer,
        createdAt: now().toISOString()
      });
      dependencies.ledger.recordHumanDecision(decision);
      if (decision.decision === "certify") dependencies.ledger.certify(proposalId);
      return requireSummary(proposalId);
    },

    retire(packId, version, reason) {
      dependencies.ledger.retire(packId, version, reason);
    }
  };
}

function latestPassedReplay(reports: readonly ReplayReport[]): ReplayReport | undefined {
  return reports.filter((report) => report.status === "passed").at(-1);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) throw new Error("adapter_version_invalid");
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(patch) || patch >= Number.MAX_SAFE_INTEGER) {
    throw new Error("adapter_version_invalid");
  }
  return `${match[1]}.${match[2]}.${patch + 1}`;
}
