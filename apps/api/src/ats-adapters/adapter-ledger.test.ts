import type {
  AiHintPackProposal,
  AiReplayReview,
  HumanCertificationDecision,
  ReplayReport
} from "@resume/contracts";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createAdapterLedger } from "./adapter-ledger.js";

const hash = (character: string) => character.repeat(64);

function proposal(overrides: Partial<AiHintPackProposal> = {}): AiHintPackProposal {
  return {
    proposalId: "proposal-1",
    taskId: "task-1",
    lifecycleStatus: "candidate",
    provider: "structured-provider",
    model: "structured-model",
    promptVersion: "hint-proposal-v1",
    inputHash: hash("a"),
    outputHash: hash("b"),
    definition: {
      schemaVersion: 1,
      packId: "example-ats",
      version: "1.0.0",
      match: {
        sites: [{ hostSuffix: "example.test", pathPrefixes: ["/apply"] }],
        stages: ["application_form"],
        requiredTextSignals: [],
        pageFingerprintHashes: [hash("c")]
      },
      sectionRules: [],
      fieldRules: [{
        ruleId: "email",
        profilePath: "basics.email",
        labelAliases: ["Email"],
        sections: ["basics"],
        controlTypes: ["text"],
        confidence: 1
      }],
      actionRules: [],
      fixtures: [
        { fixtureId: "fixture-one", expectedProfilePaths: ["basics.email"] },
        { fixtureId: "fixture-two", expectedProfilePaths: ["basics.email"] }
      ]
    },
    unsupportedBoundaries: [],
    rejectedActions: ["terminal_submit"],
    createdAt: "2026-08-17T00:00:00.000Z",
    ...overrides
  };
}

function replay(fixtureId: string, overrides: Partial<ReplayReport> = {}): ReplayReport {
  return {
    reportId: `report-${fixtureId}`,
    proposalId: "proposal-1",
    fixtureId,
    status: "passed",
    assertions: [{ code: "zero_submit", passed: true, detail: "No submission occurred." }],
    submissionCount: 0,
    inputHash: hash("d"),
    createdAt: "2026-08-17T00:01:00.000Z",
    ...overrides
  };
}

function aiReview(overrides: Partial<AiReplayReview> = {}): AiReplayReview {
  return {
    reviewId: "ai-review-1",
    proposalId: "proposal-1",
    reportId: "report-fixture-one",
    recommendation: "accept_for_human_review",
    findings: [{ code: "safe", severity: "info", explanation: "Structured replay checks passed." }],
    provider: "structured-provider",
    model: "structured-model",
    promptVersion: "replay-review-v1",
    inputHash: hash("e"),
    outputHash: hash("f"),
    createdAt: "2026-08-17T00:02:00.000Z",
    ...overrides
  };
}

function humanDecision(overrides: Partial<HumanCertificationDecision> = {}): HumanCertificationDecision {
  return {
    reviewId: "human-review-1",
    proposalId: "proposal-1",
    decision: "certify",
    reviewer: "local-reviewer",
    aiReviewUnavailable: false,
    acknowledgedAiUnavailable: false,
    createdAt: "2026-08-17T00:03:00.000Z",
    ...overrides
  };
}

describe("createAdapterLedger", () => {
  let database: InstanceType<typeof Database>;

  beforeEach(() => {
    database = new Database(":memory:");
    migrateDatabase(database);
  });

  afterEach(() => database.close());

  it("refuses certification before replay and human review", () => {
    const ledger = createAdapterLedger(database);
    ledger.createProposal(proposal());

    expect(() => ledger.certify("proposal-1")).toThrowError("adapter_transition_denied");
  });

  it("advances only after every required fixture passes and preserves replay evidence", () => {
    const ledger = createAdapterLedger(database);
    ledger.createProposal(proposal());

    ledger.recordReplay([replay("fixture-one")]);
    expect(ledger.findReviewSummary("proposal-1")).toMatchObject({
      lifecycleStatus: "candidate",
      replayReports: [expect.objectContaining({ fixtureId: "fixture-one" })]
    });
    expect(() => ledger.recordAiReview(aiReview())).toThrowError("adapter_transition_denied");

    ledger.recordReplay([replay("fixture-two")]);
    expect(ledger.findReviewSummary("proposal-1")?.lifecycleStatus).toBe("replay_verified");
  });

  it("certifies only after structured AI and human review and keeps certified versions immutable", () => {
    const ledger = createAdapterLedger(database);
    const candidate = proposal();
    ledger.createProposal(candidate);
    ledger.recordReplay([replay("fixture-one"), replay("fixture-two")]);
    ledger.recordAiReview(aiReview());
    ledger.recordHumanDecision(humanDecision());

    const certified = ledger.certify("proposal-1");

    expect(certified).toMatchObject({
      packId: "example-ats",
      version: "1.0.0",
      lifecycleStatus: "certified",
      provenance: {
        proposalId: "proposal-1",
        replayReportIds: ["report-fixture-one", "report-fixture-two"],
        aiReviewId: "ai-review-1",
        humanReviewId: "human-review-1"
      }
    });
    expect(ledger.listCertified()).toEqual([certified]);
    expect(() => ledger.certify("proposal-1")).toThrowError("adapter_transition_denied");
    expect(() => ledger.createProposal(proposal({ proposalId: "proposal-2", taskId: "task-2" })))
      .toThrow();
    expect(database.prepare("SELECT payload_json FROM ats_adapter_ai_reviews WHERE review_id = ?").get("ai-review-1"))
      .toEqual({ payload_json: JSON.stringify(aiReview()) });
  });

  it("allows the explicitly acknowledged AI-unavailable path but no other replay-to-human path", () => {
    const ledger = createAdapterLedger(database);
    ledger.createProposal(proposal());
    ledger.recordReplay([replay("fixture-one"), replay("fixture-two")]);

    expect(() => ledger.recordHumanDecision(humanDecision({
      aiReviewUnavailable: true,
      acknowledgedAiUnavailable: false
    }))).toThrow();
    expect(ledger.findReviewSummary("proposal-1")?.lifecycleStatus).toBe("replay_verified");

    ledger.recordHumanDecision(humanDecision({
      aiReviewUnavailable: true,
      acknowledgedAiUnavailable: true
    }));

    expect(ledger.findReviewSummary("proposal-1")).toMatchObject({
      lifecycleStatus: "human_reviewed",
      aiReviewUnavailable: true
    });
    expect(ledger.certify("proposal-1").provenance.aiReviewId).toBeUndefined();
  });

  it("rejects non-structured AI records and excludes rejected fingerprints from active lookup", () => {
    const ledger = createAdapterLedger(database);
    const candidate = proposal();
    ledger.createProposal(candidate);
    expect(ledger.findProposal("proposal-1")).toEqual(candidate);
    expect(ledger.findActiveByFingerprint("task-1", hash("a"))?.lifecycleStatus).toBe("candidate");
    ledger.recordReplay([replay("fixture-one"), replay("fixture-two")]);

    expect(() => ledger.recordAiReview({ ...aiReview(), rawResponse: "not-stored" } as AiReplayReview))
      .toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_ai_reviews").get()).toEqual({ count: 0 });

    ledger.recordAiReview(aiReview());
    ledger.recordHumanDecision(humanDecision({ decision: "reject" }));
    expect(ledger.findReviewSummary("proposal-1")?.lifecycleStatus).toBe("rejected");
    expect(ledger.findActiveByFingerprint("task-1", hash("a"))).toBeUndefined();
    expect(() => ledger.certify("proposal-1")).toThrowError("adapter_transition_denied");
  });

  it("records immutable retirement tombstones for local and built-in packs", () => {
    const ledger = createAdapterLedger(database);
    ledger.retire("built-in-pack", "2.0.0", "unsafe mapping");
    ledger.retire("built-in-pack", "2.0.0", "replacement reason must not overwrite");

    expect(ledger.isRetired("built-in-pack", "2.0.0")).toBe(true);
    expect(database.prepare("SELECT reason FROM ats_adapter_pack_retirements WHERE pack_id = ? AND version = ?")
      .get("built-in-pack", "2.0.0")).toEqual({ reason: "unsafe mapping" });

    ledger.createProposal(proposal());
    ledger.recordReplay([replay("fixture-one"), replay("fixture-two")]);
    ledger.recordAiReview(aiReview());
    ledger.recordHumanDecision(humanDecision());
    ledger.certify("proposal-1");
    ledger.retire("example-ats", "1.0.0", "superseded mapping");
    ledger.retire("example-ats", "1.0.0", "replacement reason must not overwrite");

    expect(ledger.isRetired("example-ats", "1.0.0")).toBe(true);
    expect(ledger.listCertified()).toEqual([]);
    expect(database.prepare(`
      SELECT lifecycle_status, retirement_reason FROM ats_adapter_certified_packs
      WHERE pack_id = ? AND version = ?
    `).get("example-ats", "1.0.0")).toEqual({
      lifecycle_status: "retired",
      retirement_reason: "superseded mapping"
    });
  });
});
