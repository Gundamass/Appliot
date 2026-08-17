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
const matchingReference = /^ats:sha256:\d{1,3}:[a-f0-9]{64}$/u;

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
    expect(ledger.findReviewSummary("proposal-1")?.aiReview).toMatchObject({
      recommendation: "accept_for_human_review",
      findings: [{
        code: "safe",
        severity: "info",
        explanation: "redacted:finding:safe:info:recommendation-accept_for_human_review"
      }]
    });
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
    expect(ledger.findProposal("proposal-1")).toMatchObject({
      definition: {
        fieldRules: [expect.objectContaining({
          labelAliases: [expect.stringMatching(matchingReference)]
        })]
      }
    });
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

  it("rejects PII in candidate labels before proposal persistence", () => {
    const ledger = createAdapterLedger(database);
    const candidate = proposal();

    expect(() => ledger.createProposal({
      ...candidate,
      definition: {
        ...candidate.definition,
        fieldRules: [{
          ...candidate.definition.fieldRules[0]!,
          labelAliases: ["联系 13800138000"]
        }]
      }
    })).toThrowError("adapter_sensitive_payload_rejected");

    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_proposals").get()).toEqual({ count: 0 });
  });

  it("rejects sensitive replay details before report persistence", () => {
    const ledger = createAdapterLedger(database);
    ledger.createProposal(proposal());

    expect(() => ledger.recordReplay([replay("fixture-one", {
      assertions: [{ code: "zero_submit", passed: true, detail: "Cookie: session=secret" }]
    })])).toThrowError("adapter_sensitive_payload_rejected");

    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_replay_reports").get()).toEqual({ count: 0 });
  });

  it("rejects sensitive AI findings before review persistence", () => {
    const ledger = createAdapterLedger(database);
    ledger.createProposal(proposal());
    ledger.recordReplay([replay("fixture-one"), replay("fixture-two")]);

    expect(() => ledger.recordAiReview(aiReview({
      findings: [{ code: "unsafe", severity: "error", explanation: "联系 user@example.com" }]
    }))).toThrowError("adapter_sensitive_payload_rejected");

    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_ai_reviews").get()).toEqual({ count: 0 });
  });

  it("rejects sensitive human notes before decision persistence", () => {
    const ledger = createAdapterLedger(database);
    ledger.createProposal(proposal());
    ledger.recordReplay([replay("fixture-one"), replay("fixture-two")]);
    ledger.recordAiReview(aiReview());

    expect(() => ledger.recordHumanDecision(humanDecision({ notes: "Bearer production-secret" })))
      .toThrowError("adapter_sensitive_payload_rejected");

    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_human_reviews").get()).toEqual({ count: 0 });
  });

  it("rejects raw HTML fragments before proposal persistence", () => {
    const ledger = createAdapterLedger(database);
    const candidate = proposal();

    expect(() => ledger.createProposal({
      ...candidate,
      definition: {
        ...candidate.definition,
        fieldRules: [{
          ...candidate.definition.fieldRules[0]!,
          labelAliases: ["<section data-field='email'>Email</section>"]
        }]
      }
    })).toThrowError("adapter_sensitive_payload_rejected");

    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_proposals").get()).toEqual({ count: 0 });
  });

  it("rejects screenshot and base64 artifacts before replay persistence", () => {
    const ledger = createAdapterLedger(database);
    ledger.createProposal(proposal());
    const screenshot = `data:image/png;base64,${Buffer.alloc(96, 7).toString("base64")}`;

    expect(() => ledger.recordReplay([replay("fixture-one", {
      assertions: [{ code: "zero_submit", passed: true, detail: screenshot }]
    })])).toThrowError("adapter_sensitive_payload_rejected");

    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_replay_reports").get()).toEqual({ count: 0 });
  });

  it("rejects credential-shaped AI findings before review persistence", () => {
    const ledger = createAdapterLedger(database);
    ledger.createProposal(proposal());
    ledger.recordReplay([replay("fixture-one"), replay("fixture-two")]);

    expect(() => ledger.recordAiReview(aiReview({
      findings: [{ code: "unsafe", severity: "error", explanation: "client_secret sk_live_test_1234567890" }]
    }))).toThrowError("adapter_sensitive_payload_rejected");

    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_ai_reviews").get()).toEqual({ count: 0 });
  });

  it("rejects executable browser command artifacts before human review persistence", () => {
    const ledger = createAdapterLedger(database);
    ledger.createProposal(proposal());
    ledger.recordReplay([replay("fixture-one"), replay("fixture-two")]);
    ledger.recordAiReview(aiReview());
    const rawCommand = JSON.stringify({ type: "fill", fieldId: "email", value: "synthetic-value" });

    expect(() => ledger.recordHumanDecision(humanDecision({ notes: rawCommand })))
      .toThrowError("adapter_sensitive_payload_rejected");

    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_human_reviews").get()).toEqual({ count: 0 });
  });

  it.each([
    "api-key synthetic",
    "client-secret synthetic",
    "node-ref synthetic",
    "type/fill/field-id/value",
    "screenshot: page.png",
    "approval: cap-abc",
    "credential id AKIAIOSFODNN7EXAMPLE",
    `ats:sha256:5:${"a".repeat(64)}`
  ])("rejects punctuation-normalized artifact metadata: %s", (artifact) => {
    const ledger = createAdapterLedger(database);
    const candidate = proposal();

    expect(() => ledger.createProposal({
      ...candidate,
      definition: {
        ...candidate.definition,
        fieldRules: [{
          ...candidate.definition.fieldRules[0]!,
          labelAliases: [artifact]
        }]
      }
    })).toThrowError("adapter_sensitive_payload_rejected");
    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_proposals").get()).toEqual({ count: 0 });
  });

  it("persists arbitrary bounded ATS matching text as opaque references", () => {
    const ledger = createAdapterLedger(database);
    const candidate = proposal();
    const atsText = [
      "Candidate Details",
      "Candidate Information Session",
      "Employment History",
      "Preferred First Name",
      "Add another employment"
    ];

    ledger.createProposal({
      ...candidate,
      definition: {
        ...candidate.definition,
        match: {
          ...candidate.definition.match,
          requiredTextSignals: [atsText[0]!, atsText[1]!]
        },
        sectionRules: [{
          section: "work",
          headingAliases: [atsText[2]!],
          fieldOrderAliases: [[atsText[3]!]]
        }],
        fieldRules: [{
          ...candidate.definition.fieldRules[0]!,
          labelAliases: [atsText[3]!]
        }],
        actionRules: [{
          kind: "add_repeated_entry",
          verbs: [atsText[4]!],
          sections: ["work"]
        }]
      }
    });

    const persisted = ledger.findProposal("proposal-1")!;
    expect(persisted.definition.match.requiredTextSignals).toEqual([
      expect.stringMatching(matchingReference),
      expect.stringMatching(matchingReference)
    ]);
    expect(persisted.definition.sectionRules[0]).toMatchObject({
      headingAliases: [expect.stringMatching(matchingReference)],
      fieldOrderAliases: [[expect.stringMatching(matchingReference)]]
    });
    expect(persisted.definition.fieldRules[0]?.labelAliases)
      .toEqual([expect.stringMatching(matchingReference)]);
    expect(persisted.definition.actionRules[0]?.verbs)
      .toEqual([expect.stringMatching(matchingReference)]);
    const payload = (database.prepare("SELECT payload_json FROM ats_adapter_proposals").get() as { payload_json: string })
      .payload_json;
    for (const value of atsText) expect(payload).not.toContain(value);
  });

  it("returns explicit redacted review meaning without original prose or PII", () => {
    const ledger = createAdapterLedger(database);
    const profileValue = "Candidate name Alice Example";
    ledger.createProposal(proposal({ unsupportedBoundaries: [profileValue] }));
    ledger.recordReplay([
      replay("fixture-one", {
        assertions: [{ code: "zero_submit", passed: true, detail: profileValue }]
      }),
      replay("fixture-two")
    ]);
    ledger.recordAiReview(aiReview({
      findings: [{ code: "safe", severity: "info", explanation: profileValue }]
    }));
    ledger.recordHumanDecision(humanDecision({ notes: profileValue }));

    for (const table of [
      "ats_adapter_proposals",
      "ats_adapter_replay_reports",
      "ats_adapter_ai_reviews",
      "ats_adapter_human_reviews"
    ]) {
      const rows = database.prepare(`SELECT payload_json FROM ${table}`).all() as Array<{ payload_json: string }>;
      expect(rows).not.toHaveLength(0);
      expect(rows.every(({ payload_json }) => !payload_json.includes(profileValue))).toBe(true);
    }
    expect(ledger.findReviewSummary("proposal-1")).toMatchObject({
      proposal: { unsupportedBoundaries: ["redacted:unsupported-boundary"] },
      replayReports: expect.arrayContaining([expect.objectContaining({
        status: "passed",
        assertions: [expect.objectContaining({
          code: "zero_submit",
          passed: true,
          detail: "redacted:assertion:zero_submit:passed:report-passed"
        })]
      })]),
      aiReview: {
        recommendation: "accept_for_human_review",
        findings: [expect.objectContaining({
          code: "safe",
          severity: "info",
          explanation: "redacted:finding:safe:info:recommendation-accept_for_human_review"
        })]
      },
      humanDecision: {
        decision: "certify",
        notes: "redacted:human-decision:certify:ai-review-available:fallback-not-acknowledged"
      }
    });
  });

  it("hashes arbitrary retirement reasons and rejects unsafe retirement identifiers", () => {
    const ledger = createAdapterLedger(database);
    const profileValue = "Candidate name Alice Example";

    ledger.retire("built-in-pack", "2.0.0", profileValue);

    const retirement = database.prepare(`
      SELECT pack_id, version, reason FROM ats_adapter_pack_retirements
      WHERE pack_id = ? AND version = ?
    `).get("built-in-pack", "2.0.0") as { pack_id: string; version: string; reason: string };
    expect(retirement).toEqual({
      pack_id: "built-in-pack",
      version: "2.0.0",
      reason: "redacted:retirement-reason"
    });
    expect(JSON.stringify(retirement)).not.toContain(profileValue);
    expect(() => ledger.retire("candidate@example.com", "2.0.0", "unsafe mapping"))
      .toThrowError("adapter_sensitive_payload_rejected");
    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_pack_retirements").get()).toEqual({ count: 1 });
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
