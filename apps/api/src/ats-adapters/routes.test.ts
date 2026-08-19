import Fastify from "fastify";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiHintPackProposal,
  AiReplayReview,
  HintPackDefinition,
  ReplayReport
} from "@resume/contracts";
import { createApp } from "../app.js";
import { migrateDatabase } from "../db/migrate.js";
import { createProfileRepository } from "../profile/profile-repository.js";
import { createAdapterLedger } from "./adapter-ledger.js";
import { createAdapterReviewService } from "./adapter-review-service.js";
import { registerAdapterRoutes } from "./routes.js";

const resources: Array<{ app: ReturnType<typeof Fastify>; database: InstanceType<typeof Database> }> = [];

afterEach(async () => {
  while (resources.length > 0) {
    const resource = resources.pop();
    await resource?.app.close();
    resource?.database.close();
  }
});

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
      labelAliases: ["Synthetic candidate label"],
      sections: ["basics"],
      controlTypes: ["text"],
      confidence: 1
    }],
    actionRules: [],
    fixtures: [{ fixtureId: "fixture-basic", expectedProfilePaths: ["basics.name"] }],
    ...overrides
  };
}

function proposal(): AiHintPackProposal {
  return {
    proposalId: "proposal-1",
    taskId: "task-review",
    lifecycleStatus: "candidate",
    provider: "fixture-provider",
    model: "fixture-model",
    promptVersion: "hint-proposal-v1",
    inputHash: "a".repeat(64),
    outputHash: "b".repeat(64),
    definition: definition(),
    unsupportedBoundaries: [],
    rejectedActions: [],
    createdAt: "2026-08-17T00:00:00.000Z"
  };
}

function replay(candidate: AiHintPackProposal): ReplayReport {
  return {
    reportId: "report-1",
    proposalId: candidate.proposalId,
    fixtureId: "fixture-basic",
    status: "passed",
    assertions: [{ code: "zero_submit", passed: true, detail: "synthetic replay passed" }],
    submissionCount: 0,
    inputHash: "c".repeat(64),
    createdAt: "2026-08-17T00:01:00.000Z"
  };
}

function aiReview(candidate: AiHintPackProposal, report: ReplayReport): AiReplayReview {
  return {
    reviewId: "ai-review-1",
    proposalId: candidate.proposalId,
    reportId: report.reportId,
    recommendation: "accept_for_human_review",
    findings: [],
    provider: "fixture-provider",
    model: "fixture-model",
    promptVersion: "replay-review-v1",
    inputHash: "d".repeat(64),
    outputHash: "e".repeat(64),
    createdAt: "2026-08-17T00:02:00.000Z"
  };
}

function harness(options: { aiAvailable?: boolean } = {}) {
  const database = new Database(":memory:");
  migrateDatabase(database);
  const ledger = createAdapterLedger(database);
  const candidate = proposal();
  ledger.createProposal(candidate);
  const replayRunner = {
    run: vi.fn(async (current: AiHintPackProposal) => ({ taskId: "synthetic-task", reports: [replay(current)] }))
  };
  const aiReplayReviewService = options.aiAvailable === false ? undefined : {
    review: vi.fn(async (current: AiHintPackProposal, report: ReplayReport) => {
      const review = aiReview(current, report);
      ledger.recordAiReview(review);
      return { kind: "reviewed" as const, lifecycleStatus: "ai_reviewed" as const, review };
    })
  };
  let nextId = 0;
  const service = createAdapterReviewService({
    ledger,
    replayRunner,
    ...(aiReplayReviewService === undefined ? {} : { aiReplayReviewService }),
    listProfilePaths: () => ["basics.name"],
    reviewer: "local-user",
    createId: () => `local-review-${++nextId}`,
    now: () => new Date("2026-08-17T00:03:00.000Z")
  });
  const app = Fastify({ logger: false });
  registerAdapterRoutes(app, service);
  resources.push({ app, database });
  return { app, candidate, database, ledger, service };
}

describe("ATS adapter review routes", () => {
  it("returns sanitized review data and cannot certify before deterministic replay", async () => {
    const { app, candidate } = harness();

    const detail = await app.inject({ method: "GET", url: `/api/ats-adapters/proposals/${candidate.proposalId}` });
    const certification = await app.inject({
      method: "POST",
      url: `/api/ats-adapters/proposals/${candidate.proposalId}/decision`,
      payload: {
        decision: "certify",
        aiReviewUnavailable: false,
        acknowledgedAiUnavailable: false
      }
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      proposal: { proposalId: candidate.proposalId },
      lifecycleStatus: "candidate",
      writeBlocked: true
    });
    expect(detail.body).not.toMatch(/Synthetic candidate label|currentValue|nodeRef|cookie|approval/iu);
    expect(certification.statusCode).toBe(409);
    expect(certification.json()).toMatchObject({ error: "ATS adapter operation conflicts with current lifecycle", code: "adapter_transition_denied" });
  });

  it("returns an explicit unavailable result only after replay and rejects invalid bodies", async () => {
    const { app, candidate } = harness({ aiAvailable: false });

    const invalid = await app.inject({
      method: "POST",
      url: `/api/ats-adapters/proposals/${candidate.proposalId}/decision`,
      payload: { decision: "certify", aiReviewUnavailable: false, acknowledgedAiUnavailable: false, reviewer: "forged" }
    });
    const replayResponse = await app.inject({ method: "POST", url: `/api/ats-adapters/proposals/${candidate.proposalId}/replay` });
    const unavailable = await app.inject({ method: "POST", url: `/api/ats-adapters/proposals/${candidate.proposalId}/ai-review` });
    const detail = await app.inject({ method: "GET", url: `/api/ats-adapters/proposals/${candidate.proposalId}` });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "invalid_adapter_decision_input" });
    expect(replayResponse.statusCode).toBe(200);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ error: "AI replay review is temporarily unavailable", code: "adapter_ai_unavailable" });
    expect(detail.json()).toMatchObject({ aiReviewUnavailable: true, lifecycleStatus: "replay_verified" });
  });

  it("derives the local reviewer, creates immutable revisions, and retires a certified version", async () => {
    const { app, candidate, ledger } = harness();

    await app.inject({ method: "POST", url: `/api/ats-adapters/proposals/${candidate.proposalId}/replay` });
    await app.inject({ method: "POST", url: `/api/ats-adapters/proposals/${candidate.proposalId}/ai-review` });
    const certified = await app.inject({
      method: "POST",
      url: `/api/ats-adapters/proposals/${candidate.proposalId}/decision`,
      headers: { "x-reviewer": "forged-reviewer" },
      payload: { decision: "certify", aiReviewUnavailable: false, acknowledgedAiUnavailable: false }
    });
    const revised = await app.inject({
      method: "POST",
      url: `/api/ats-adapters/proposals/${candidate.proposalId}/revise`,
      payload: definition({ version: "9.9.9" })
    });
    const retired = await app.inject({
      method: "POST",
      url: "/api/ats-adapters/packs/example-ats/1.0.0/retire",
      payload: { reason: "synthetic drift" }
    });

    expect(certified.statusCode).toBe(200);
    expect(certified.json()).toMatchObject({ humanDecision: { reviewer: "local-user" }, lifecycleStatus: "certified" });
    expect(revised.statusCode).toBe(201);
    expect(revised.json()).toMatchObject({
      proposal: { parentProposalId: candidate.proposalId, lifecycleStatus: "candidate", definition: { version: "1.0.1" } }
    });
    expect(retired.statusCode).toBe(204);
    expect(ledger.isRetired("example-ats", "1.0.0")).toBe(true);
  });

  it("is registered by the application composition", async () => {
    const { candidate, service } = harness();
    const database = new Database(":memory:");
    migrateDatabase(database);
    const app = await createApp({
      database,
      profileRepository: createProfileRepository(database),
      originalDocumentStore: {} as never,
      extractPdf: vi.fn(),
      extractFacts: vi.fn(),
      adapterReviewService: service,
      close: () => {
        database.close();
      }
    });
    resources.push({ app, database });

    const response = await app.inject({ method: "GET", url: `/api/ats-adapters/proposals/${candidate.proposalId}` });

    expect(response.statusCode).toBe(200);
  });
});
