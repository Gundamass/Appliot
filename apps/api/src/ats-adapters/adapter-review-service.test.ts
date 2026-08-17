import { createHash } from "node:crypto";
import type {
  AiHintPackProposal,
  AiReplayReview,
  FormSnapshot,
  HintPackDefinition,
  ReplayReport
} from "@resume/contracts";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createAdapterLedger } from "./adapter-ledger.js";
import { sanitizeAdapterObservation } from "./observation-sanitizer.js";
import { createAdapterReviewService } from "./adapter-review-service.js";

const hash = (character: string) => character.repeat(64);
const nodeRef = {
  documentId: "document-review-00000001",
  nodeId: "node-review-000000000001",
  observedAt: 1
};

function snapshot(): FormSnapshot {
  return {
    id: "snapshot-review",
    taskId: "task-review",
    url: "https://jobs.example.test/apply",
    title: "Application",
    stage: "application_form",
    frameRef: { documentId: nodeRef.documentId, kind: "main" },
    mutationEpoch: nodeRef.observedAt,
    fields: [{
      id: "field-name",
      label: "Name",
      type: "text",
      required: true,
      options: [],
      currentValue: "",
      sectionHint: "basics",
      nodeRef
    }],
    actions: [],
    errors: []
  };
}

function definition(overrides: Partial<HintPackDefinition> = {}): HintPackDefinition {
  return {
    schemaVersion: 1,
    packId: "example-ats",
    version: "1.0.0",
    match: {
      sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/apply"] }],
      stages: ["application_form"],
      requiredTextSignals: [],
      pageFingerprintHashes: []
    },
    sectionRules: [],
    fieldRules: [{
      ruleId: "name",
      profilePath: "basics.name",
      labelAliases: ["Name"],
      sections: ["basics"],
      controlTypes: ["text"],
      confidence: 1
    }],
    actionRules: [],
    fixtures: [{ fixtureId: "fixture-basic", expectedProfilePaths: ["basics.name"] }],
    ...overrides
  };
}

function proposal(input: {
  proposalId?: string;
  taskId?: string;
  inputHash?: string;
  definition?: HintPackDefinition;
} = {}): AiHintPackProposal {
  return {
    proposalId: input.proposalId ?? "proposal-1",
    taskId: input.taskId ?? "task-review",
    lifecycleStatus: "candidate",
    provider: "fixture-provider",
    model: "fixture-model",
    promptVersion: "hint-proposal-v1",
    inputHash: input.inputHash ?? hash("a"),
    outputHash: hash("b"),
    definition: input.definition ?? definition(),
    unsupportedBoundaries: [],
    rejectedActions: [],
    createdAt: "2026-08-17T00:00:00.000Z"
  };
}

function replay(candidate: AiHintPackProposal): ReplayReport {
  return {
    reportId: `report-${candidate.proposalId}`,
    proposalId: candidate.proposalId,
    fixtureId: "fixture-basic",
    status: "passed",
    assertions: [{ code: "zero_submit", passed: true, detail: "synthetic replay completed" }],
    submissionCount: 0,
    inputHash: hash("c"),
    createdAt: "2026-08-17T00:01:00.000Z"
  };
}

function aiReview(candidate: AiHintPackProposal, report: ReplayReport): AiReplayReview {
  return {
    reviewId: `ai-${candidate.proposalId}`,
    proposalId: candidate.proposalId,
    reportId: report.reportId,
    recommendation: "accept_for_human_review",
    findings: [],
    provider: "fixture-provider",
    model: "fixture-model",
    promptVersion: "replay-review-v1",
    inputHash: hash("d"),
    outputHash: hash("e"),
    createdAt: "2026-08-17T00:02:00.000Z"
  };
}

function observationHash(page: FormSnapshot, profilePaths: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(sanitizeAdapterObservation(page, profilePaths)), "utf8")
    .digest("hex");
}

describe("createAdapterReviewService", () => {
  let database: InstanceType<typeof Database>;

  beforeEach(() => {
    database = new Database(":memory:");
    migrateDatabase(database);
  });

  afterEach(() => database.close());

  it("reuses the active candidate and certifies only after replay, AI, and human review", async () => {
    const ledger = createAdapterLedger(database);
    const propose = vi.fn(async (input: { taskId: string; snapshot: FormSnapshot; profilePaths: readonly string[] }) => {
      const candidate = proposal({
        proposalId: "proposal-1",
        taskId: input.taskId,
        inputHash: observationHash(input.snapshot, input.profilePaths)
      });
      ledger.createProposal(candidate);
      return ledger.findProposal(candidate.proposalId)!;
    });
    const replayRunner = {
      run: vi.fn(async (candidate: AiHintPackProposal) => ({
        taskId: "synthetic-task-1",
        reports: [replay(candidate)]
      }))
    };
    const aiReplayReviewService = {
      review: vi.fn(async (candidate: AiHintPackProposal, report: ReplayReport) => {
        const review = aiReview(candidate, report);
        ledger.recordAiReview(review);
        return { kind: "reviewed" as const, lifecycleStatus: "ai_reviewed" as const, review };
      })
    };
    const service = createAdapterReviewService({
      ledger,
      aiProposalService: { propose },
      replayRunner,
      aiReplayReviewService,
      listProfilePaths: () => ["basics.name"],
      reviewer: "local-user",
      createId: () => "human-review-1",
      now: () => new Date("2026-08-17T00:03:00.000Z")
    });

    const first = await service.prepare("task-review", snapshot());
    const second = await service.prepare("task-review", snapshot());

    expect(first).toMatchObject({ lifecycleStatus: "candidate", writeBlocked: true });
    expect(second.proposal?.proposalId).toBe("proposal-1");
    expect(propose).toHaveBeenCalledOnce();

    expect(await service.replay("proposal-1")).toMatchObject({ lifecycleStatus: "replay_verified" });
    expect(await service.requestAiReview("proposal-1")).toMatchObject({ lifecycleStatus: "ai_reviewed" });
    expect(service.decide("proposal-1", {
      decision: "certify",
      aiReviewUnavailable: false,
      acknowledgedAiUnavailable: false
    })).toMatchObject({ lifecycleStatus: "certified" });
    expect(ledger.listCertified()).toHaveLength(1);
  });

  it("keeps an AI-unavailable replay review-only until a human explicitly acknowledges the fallback", async () => {
    const ledger = createAdapterLedger(database);
    const candidate = proposal();
    ledger.createProposal(candidate);
    const service = createAdapterReviewService({
      ledger,
      aiProposalService: { propose: vi.fn() },
      replayRunner: {
        run: vi.fn(async () => ({ taskId: "synthetic-task-1", reports: [replay(candidate)] }))
      },
      aiReplayReviewService: {
        review: vi.fn(async () => ({ kind: "unavailable" as const, lifecycleStatus: "replay_verified" as const }))
      },
      listProfilePaths: () => ["basics.name"],
      reviewer: "local-user",
      createId: () => "human-review-1",
      now: () => new Date("2026-08-17T00:03:00.000Z")
    });

    await service.replay(candidate.proposalId);
    expect(await service.requestAiReview(candidate.proposalId)).toMatchObject({
      lifecycleStatus: "replay_verified",
      aiReviewUnavailable: true
    });
    expect(() => service.decide(candidate.proposalId, {
      decision: "certify",
      aiReviewUnavailable: true,
      acknowledgedAiUnavailable: false
    })).toThrow("adapter_transition_denied");
    expect(service.decide(candidate.proposalId, {
      decision: "certify",
      aiReviewUnavailable: true,
      acknowledgedAiUnavailable: true
    })).toMatchObject({ lifecycleStatus: "certified" });
  });

  it("revises into an immutable patch candidate and retires the requested certified version", async () => {
    const ledger = createAdapterLedger(database);
    const candidate = proposal();
    ledger.createProposal(candidate);
    const service = createAdapterReviewService({
      ledger,
      aiProposalService: { propose: vi.fn() },
      replayRunner: { run: vi.fn() },
      aiReplayReviewService: { review: vi.fn() },
      listProfilePaths: () => ["basics.name"],
      reviewer: "local-user",
      createId: () => "proposal-revision-1",
      now: () => new Date("2026-08-17T00:03:00.000Z")
    });

    const revised = await service.revise(candidate.proposalId, definition({ version: "9.9.9" }));

    expect(revised.proposal).toMatchObject({
      proposalId: "proposal-revision-1",
      parentProposalId: candidate.proposalId,
      lifecycleStatus: "candidate",
      definition: { version: "1.0.1" }
    });
    service.retire("example-ats", "1.0.1", "unsafe mapping");
    expect(ledger.isRetired("example-ats", "1.0.1")).toBe(true);
  });
});
