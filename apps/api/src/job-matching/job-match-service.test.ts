import Database from "better-sqlite3";
import type {
  JobExpectationSnapshot,
  JobMatchResult,
  JobPageSnapshot,
  JobPosting
} from "@resume/contracts";
import { mokaJobAdapter, type JobAdapter } from "@resume/job-matching";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationTaskRepository } from "../applications/application-task-repository.js";
import { BrowserOwnershipLease } from "../browser/browser-ownership-lease.js";
import { migrateDatabase } from "../db/migrate.js";
import { BoundedJobMatchTraceBuffer } from "../observability/job-match-trace.js";
import { createJobMatchRepository } from "./job-match-repository.js";
import { conflictSummaryHash, createJobMatchService } from "./job-match-service.js";

const databases: Database.Database[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

const expectation: JobExpectationSnapshot = {
  revision: 2,
  confirmedAt: "2026-08-16T00:00:00.000Z",
  criteria: [{ kind: "location", values: ["北京"], strength: "required" }]
};

function snapshot(
  entryHint: JobPageSnapshot["entryHint"],
  ownerId: string,
  url = `https://jobs.example/${entryHint}`
): JobPageSnapshot {
  return {
    id: `snapshot-${entryHint}`,
    ownerId,
    url,
    title: entryHint,
    capturedAt: "2026-08-16T00:00:00.000Z",
    entryHint,
    visibleText: [],
    jobCards: [],
    filterState: [],
    pagination: { kind: "none", hasNext: false },
    boundaries: []
  };
}

function posting(id = "posting-1"): JobPosting {
  return {
    id,
    source: "moka",
    sourceJobId: id,
    canonicalUrl: `https://jobs.example/${id}`,
    title: "Java Engineer",
    organization: "Example",
    description: "Synthetic description",
    requirements: [{
      id: "req-1",
      category: "skill",
      normalizedValue: "java",
      required: true,
      sourceEvidence: "熟悉 Java"
    }],
    adapterVersion: "moka-job-v1",
    contentHash: `hash-${id}`,
    extractedAt: "2026-08-16T00:00:00.000Z"
  };
}

function result(value: JobPosting, conflict = false): JobMatchResult {
  return {
    id: `result-${value.id}`,
    version: 0,
    sessionId: "session-1",
    postingId: value.id,
    fitScore: conflict ? 70 : 90,
    confidence: 80,
    rankingScore: conflict ? 66.5 : 85.5,
    outcomes: [{
      requirementId: "req-1",
      outcome: conflict ? "conflict" : "satisfied",
      reasonCode: conflict ? "confirmed_fact_mismatch" : "profile_evidence_match"
    }],
    evidence: [],
    gaps: conflict ? [{ requirementId: "req-1", outcome: "conflict", summary: "明确冲突" }] : [],
    scoringVersion: "job-match-v1",
    profileRevision: 7,
    expectationRevision: expectation.revision,
    postingContentHash: value.contentHash,
    stale: false
  };
}

function harness(
  entryHint: JobPageSnapshot["entryHint"] = "job_list",
  profileRevision = 7,
  expectationSnapshot = expectation,
  adapterOverride?: JobAdapter,
  url = `https://jobs.example/${entryHint}`
) {
  const database = new Database(":memory:");
  databases.push(database);
  migrateDatabase(database);
  const repository = createJobMatchRepository(database);
  const applicationTasks = createApplicationTaskRepository(database);
  const browser = {
    open: vi.fn().mockResolvedValue(undefined),
    observeJob: vi.fn(async (ownerId: string) => snapshot(entryHint, ownerId, url)),
    invalidateExecution: vi.fn().mockResolvedValue(undefined),
    releaseTask: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn()
  };
  let submissionCount = 0;
  const adapter: JobAdapter = {
    source: "moka",
    version: "moka-job-v1",
    identify: (value) => value.entryHint === "unknown" || value.entryHint === "login"
      ? "unsupported"
      : value.entryHint,
    mapFilters: vi.fn(() => ({
      source: "moka" as const,
      adapterVersion: "moka-job-v1",
      mapped: [{ criterionIndex: 0, key: "location", values: ["北京"] }],
      localOnly: []
    })),
    extractList: vi.fn(() => ({ postings: [], hasNext: false })),
    extractDetail: vi.fn()
  };
  const trace = new BoundedJobMatchTraceBuffer();
  const browserOwnershipLease = new BrowserOwnershipLease();
  const service = createJobMatchService({
    repository,
    applicationTasks,
    browser,
    browserOwnershipLease,
    adapters: [adapterOverride ?? adapter],
    expectationSnapshot: () => expectationSnapshot,
    profileRevision: () => profileRevision,
    extraction: {
      confirmFilters: vi.fn(),
      runExtraction: vi.fn()
    },
    matcher: { match: vi.fn() },
    trace,
    createId: (kind) => kind === "session" ? "session-1" : "application-1",
    submissionCount: () => submissionCount
  });
  return {
    service,
    repository,
    applicationTasks,
    browser,
    browserOwnershipLease,
    adapter: adapterOverride ?? adapter,
    trace,
    get submissionCount() { return submissionCount; }
  };
}

function seedSelection(value: ReturnType<typeof harness>, conflict = false) {
  const job = posting();
  const match = result(job, conflict);
  value.repository.create({
    id: "session-1",
    initialUrl: "https://jobs.example",
    state: "awaiting_job_selection",
    profileRevision: 7,
    expectation
  });
  value.repository.saveExtractionPage({
    sessionId: "session-1",
    idempotencyKey: "seed-posting",
    postings: [job],
    cursor: { value: "complete", pagesRead: 1, elapsedMs: 1, newJobs: 1, consecutiveNoNewPages: 0 },
    event: { type: "seed", payload: {} }
  });
  value.repository.saveResults("session-1", [match]);
  return { job, match };
}

describe("JobMatchService entry handling", () => {
  it("presents deterministic filter plans without persisting or executing them", async () => {
    const value = harness("job_list");
    const expectedPlan = {
      source: "moka",
      adapterVersion: "moka-job-v1",
      mapped: [{ criterionIndex: 0, key: "location", values: ["北京"] }],
      localOnly: []
    };

    await expect(value.service.create({ url: "https://jobs.example/list" }))
      .resolves.toMatchObject({ filterPlan: expectedPlan });
    expect(value.service.get("session-1")).toMatchObject({ filterPlan: expectedPlan });
    expect(value.adapter.mapFilters).toHaveBeenCalledWith(expectation);
    expect(value.repository.get("session-1")).not.toHaveProperty("filterPlan");
    expect(value.browser.execute).not.toHaveBeenCalled();
  });

  it("rejects an empty expectation before acquiring or opening the browser", async () => {
    const value = harness("job_list", 7, { ...expectation, criteria: [] });

    await expect(value.service.create({ url: "https://jobs.example/list" }))
      .rejects.toThrow("job_expectation_required");
    expect(value.browserOwnershipLease.current()).toBeUndefined();
    expect(value.browser.open).not.toHaveBeenCalled();
    expect(value.browser.observeJob).not.toHaveBeenCalled();
    expect(value.repository.get("session-1")).toBeUndefined();
    expect(value.trace.snapshot()).toHaveLength(0);
  });

  it("creates list and detail sessions in their correct initial states", async () => {
    const list = harness("job_list");
    expect(await list.service.create({ url: "https://jobs.example/list" })).toMatchObject({
      version: 0,
      state: "awaiting_filter_confirmation",
      entryKind: "job_list",
      source: "moka"
    });

    const detail = harness("job_detail");
    expect(await detail.service.create({ url: "https://jobs.example/detail" })).toMatchObject({
      state: "opening_job_page",
      entryKind: "job_detail",
      source: "moka"
    });
    expect(list.browser.execute).not.toHaveBeenCalled();
    expect(detail.browser.execute).not.toHaveBeenCalled();
  });

  it("creates a campus_apply list session with the real Mokahr adapter", async () => {
    const campusUrl = "https://app.mokahr.com/campus_apply/acme-campus/39595#/jobs";
    const value = harness("job_list", 7, expectation, mokaJobAdapter, campusUrl);

    await expect(value.service.create({ url: campusUrl })).resolves.toMatchObject({
      source: "moka",
      entryKind: "job_list"
    });
    expect(value.browser.execute).not.toHaveBeenCalled();
  });

  it("persists the edited expectation when filters are confirmed", async () => {
    const value = harness("job_list");
    const created = await value.service.create({ url: "https://jobs.example/list" });
    if ("redirect" in created) throw new Error("expected a job match session");
    const edited: JobExpectationSnapshot = {
      revision: expectation.revision + 1,
      confirmedAt: "2026-08-16T00:03:00.000Z",
      criteria: [{ kind: "location", values: ["上海"], strength: "required" }]
    };

    await expect(value.service.confirmFilters("session-1", edited, {
      sessionVersion: created.version,
      idempotencyKey: "confirm-filters"
    })).resolves.toMatchObject({
      version: 1,
      state: "extracting_jobs",
      expectationRevision: edited.revision,
      expectation: edited
    });
  });

  it("redirects application-form entries without creating a match session", async () => {
    const value = harness("application_form");
    expect(await value.service.create({ url: "https://jobs.example/apply" })).toEqual({
      redirect: "application",
      applicationUrl: "https://jobs.example/apply"
    });
    expect(value.repository.get("session-1")).toBeUndefined();
    expect(value.browser.execute).not.toHaveBeenCalled();
  });
});

describe("JobMatchService selection and conversion", () => {
  it("rejects a stale conflict confirmation hash", () => {
    const value = harness();
    const seeded = seedSelection(value, true);
    expect(() => value.service.selectConflict("session-1", {
      sessionVersion: 0,
      idempotencyKey: "select-conflict",
      resultId: seeded.match.id,
      resultVersion: seeded.match.version,
      postingContentHash: seeded.job.contentHash,
      conflictSummaryHash: "stale-hash"
    })).toThrow("job_match_conflict_confirmation_stale");
  });

  it("selects an explicitly confirmed conflict with the current summary", () => {
    const value = harness();
    const seeded = seedSelection(value, true);
    expect(value.service.selectConflict("session-1", {
      sessionVersion: 0,
      idempotencyKey: "select-conflict",
      resultId: seeded.match.id,
      resultVersion: seeded.match.version,
      postingContentHash: seeded.job.contentHash,
      conflictSummaryHash: conflictSummaryHash(seeded.match)
    })).toMatchObject({ state: "selected", selectedResultId: seeded.match.id });
  });

  it("converts once and replays the same ApplicationTask for the same key", async () => {
    const value = harness();
    const seeded = seedSelection(value);
    const selected = value.service.select("session-1", {
      sessionVersion: 0,
      idempotencyKey: "select-normal",
      resultId: seeded.match.id,
      resultVersion: seeded.match.version,
      postingContentHash: seeded.job.contentHash
    });
    const guard = {
      sessionVersion: selected.version,
      idempotencyKey: "convert-once",
      resultId: seeded.match.id,
      resultVersion: seeded.match.version,
      postingContentHash: seeded.job.contentHash
    };

    const first = await value.service.convert("session-1", guard);
    expect(await value.service.convert("session-1", guard)).toEqual(first);
    expect(value.applicationTasks.list()).toHaveLength(1);
    expect(value.repository.get("session-1", { required: true })).toMatchObject({
      state: "converted_to_application",
      applicationTaskId: first.id
    });
    expect(value.browser.execute).not.toHaveBeenCalled();
    expect(value.submissionCount).toBe(0);
  });

  it("marks old results stale when the profile revision changes without rematching", () => {
    const value = harness("job_list", 8);
    seedSelection(value);
    const current = value.service.get("session-1");
    expect(current.results[0]?.stale).toBe(true);
    expect(current.state).toBe("awaiting_job_selection");
  });
});
