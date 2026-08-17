import type {
  AiHintPackProposal,
  AiReplayReview,
  ReplayReport
} from "@resume/contracts";
import type { StructuredGenerationInput, StructuredModelProvider } from "@resume/model-provider";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createAdapterLedger, type AdapterLedger } from "./adapter-ledger.js";
import { createAiReplayReviewService } from "./ai-replay-review-service.js";

const hash = (character: string) => character.repeat(64);

function proposal(): AiHintPackProposal {
  return {
    proposalId: "proposal-1",
    taskId: "task-1",
    lifecycleStatus: "candidate",
    provider: "deepseek",
    model: "deepseek-test",
    promptVersion: "hint-proposal-v1",
    inputHash: hash("a"),
    outputHash: hash("b"),
    definition: {
      schemaVersion: 1,
      packId: "example-ats",
      version: "1.0.0",
      match: {
        sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/apply"] }],
        stages: ["application_form"],
        requiredTextSignals: ["Application"],
        pageFingerprintHashes: [hash("c")]
      },
      sectionRules: [],
      fieldRules: [{
        ruleId: "email",
        profilePath: "basics.email",
        labelAliases: ["Candidate email"],
        sections: ["basics"],
        controlTypes: ["text"],
        confidence: 1
      }],
      actionRules: [],
      fixtures: [{ fixtureId: "synthetic-basic", expectedProfilePaths: ["basics.email"] }]
    },
    unsupportedBoundaries: [],
    rejectedActions: ["terminal_submit"],
    createdAt: "2026-08-17T00:00:00.000Z"
  };
}

function replay(overrides: Partial<ReplayReport> = {}): ReplayReport {
  return {
    reportId: "report-1",
    proposalId: "proposal-1",
    fixtureId: "synthetic-basic",
    status: "passed",
    assertions: [{ code: "zero_submit", passed: true, detail: "Alice Example was never submitted." }],
    submissionCount: 0,
    inputHash: hash("d"),
    createdAt: "2026-08-17T00:01:00.000Z",
    ...overrides
  };
}

function modelReview(): AiReplayReview {
  return {
    reviewId: "model-review-id",
    proposalId: "proposal-1",
    reportId: "report-1",
    recommendation: "accept_for_human_review",
    findings: [{ code: "safe", severity: "info", explanation: "The deterministic assertions passed." }],
    provider: "deepseek",
    model: "deepseek-test",
    promptVersion: "replay-review-v1",
    inputHash: hash("e"),
    outputHash: hash("f"),
    createdAt: "2026-08-17T00:02:00.000Z"
  };
}

describe("createAiReplayReviewService", () => {
  let database: InstanceType<typeof Database>;

  beforeEach(() => {
    database = new Database(":memory:");
    migrateDatabase(database);
  });

  afterEach(() => database.close());

  it("does not call AI review or advance lifecycle when a hard assertion failed", async () => {
    const generateStructured = vi.fn();
    const recordAiReview = vi.fn();
    const service = createAiReplayReviewService({
      provider: { generateStructured } as unknown as StructuredModelProvider,
      ledger: { recordAiReview } as unknown as AdapterLedger,
      providerName: "deepseek",
      model: "deepseek-test"
    });
    const failed = replay({
      status: "failed",
      assertions: [{ code: "zero_submit", passed: false, detail: "A fixture assertion failed." }]
    });

    await expect(service.review(proposal(), failed)).rejects.toThrow("hard_gate_failed");
    expect(generateStructured).not.toHaveBeenCalled();
    expect(recordAiReview).not.toHaveBeenCalled();
  });

  it("does not call AI for a structurally invalid report marked as passed", async () => {
    const generateStructured = vi.fn();
    const recordAiReview = vi.fn();
    const service = createAiReplayReviewService({
      provider: { generateStructured } as unknown as StructuredModelProvider,
      ledger: { recordAiReview } as unknown as AdapterLedger,
      providerName: "deepseek",
      model: "deepseek-test"
    });
    const invalid = replay({
      assertions: [{ code: "target_value", passed: true, detail: "A required zero-submit assertion is missing." }]
    });

    await expect(service.review(proposal(), invalid)).rejects.toThrow("hard_gate_failed");
    expect(generateStructured).not.toHaveBeenCalled();
    expect(recordAiReview).not.toHaveBeenCalled();
  });

  it("records a reviewed result from sanitized replay data", async () => {
    const ledger = createAdapterLedger(database);
    ledger.createProposal(proposal());
    const report = replay();
    ledger.recordReplay([report]);
    const generateStructured = vi.fn(async (input: StructuredGenerationInput<unknown>) => input.schema.parse(modelReview()));
    const service = createAiReplayReviewService({
      provider: {
        generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
          return generateStructured(input) as Promise<T>;
        }
      },
      ledger,
      providerName: "deepseek",
      model: "deepseek-test",
      createId: () => "review-1",
      now: () => new Date("2026-08-17T00:02:00.000Z")
    });

    const result = await service.review(ledger.findProposal("proposal-1")!, report);

    expect(result).toMatchObject({ kind: "reviewed", lifecycleStatus: "ai_reviewed" });
    expect(generateStructured).toHaveBeenCalledOnce();
    expect(generateStructured.mock.calls[0]![0]!.metadata).toEqual({
      requestId: "proposal-1",
      purpose: "adapter_replay_review"
    });
    const prompt = JSON.stringify(generateStructured.mock.calls[0]![0]!);
    expect(prompt).not.toContain("Alice Example");
    expect(prompt).not.toContain("Candidate email");
    expect(ledger.findReviewSummary("proposal-1")).toMatchObject({
      lifecycleStatus: "ai_reviewed",
      aiReview: {
        reviewId: "review-1",
        findings: [{ explanation: "redacted:finding:safe:info:recommendation-accept_for_human_review" }]
      }
    });
  });

  it("leaves replay verified when the model is unavailable", async () => {
    const ledger = createAdapterLedger(database);
    ledger.createProposal(proposal());
    const report = replay();
    ledger.recordReplay([report]);
    const service = createAiReplayReviewService({
      provider: { generateStructured: vi.fn(async () => { throw new Error("provider unavailable"); }) } as StructuredModelProvider,
      ledger,
      providerName: "deepseek",
      model: "deepseek-test"
    });

    await expect(service.review(ledger.findProposal("proposal-1")!, report)).resolves.toEqual({
      kind: "unavailable",
      lifecycleStatus: "replay_verified"
    });
    expect(ledger.findReviewSummary("proposal-1")).toMatchObject({ lifecycleStatus: "replay_verified" });
  });

  it("fails closed instead of returning an unpersisted AI finding", async () => {
    const generateStructured = vi.fn(async (input: StructuredGenerationInput<unknown>) => input.schema.parse(modelReview()));
    const service = createAiReplayReviewService({
      provider: {
        generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
          return generateStructured(input) as Promise<T>;
        }
      },
      ledger: {
        recordAiReview: vi.fn(),
        findReviewSummary: vi.fn(() => undefined)
      },
      providerName: "deepseek",
      model: "deepseek-test",
      createId: () => "review-1",
      now: () => new Date("2026-08-17T00:02:00.000Z")
    });

    await expect(service.review(proposal(), replay())).rejects.toThrow("adapter_ai_review_persistence_failed");
  });
});
