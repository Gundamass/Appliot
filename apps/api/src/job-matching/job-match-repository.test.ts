import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { JobExpectationSnapshot, JobMatchResult, JobPosting } from "@resume/contracts";
import { migrateDatabase } from "../db/migrate.js";
import { createJobMatchRepository } from "./job-match-repository.js";

const expectation: JobExpectationSnapshot = {
  revision: 1,
  criteria: [{ kind: "target_role", values: ["Java 开发"], strength: "required" }],
  confirmedAt: "2026-08-16T00:00:00.000Z"
};

function posting(id = "posting-1", contentHash = "sha256:posting-1"): JobPosting {
  return {
    id,
    source: "moka",
    sourceJobId: "job-1001",
    canonicalUrl: "https://jobs.example.test/jobs/1001",
    title: "Java 开发工程师",
    organization: "示例科技",
    location: "深圳",
    employmentType: "全职",
    description: "负责服务端功能开发。",
    requirements: [{
      id: "requirement-java",
      category: "skill",
      normalizedValue: "java",
      required: true,
      sourceEvidence: "熟悉 Java"
    }],
    adapterVersion: "moka-job-v1",
    contentHash,
    extractedAt: "2026-08-16T00:01:00.000Z"
  };
}

function result(postingValue = posting()): JobMatchResult {
  return {
    id: "result-1",
    version: 1,
    sessionId: "session-1",
    postingId: postingValue.id,
    fitScore: 75,
    confidence: 65.5,
    rankingScore: 68.53,
    outcomes: [{ requirementId: "requirement-java", outcome: "unknown", reasonCode: "profile_fact_missing" }],
    evidence: [],
    gaps: [{ requirementId: "requirement-java", outcome: "unknown", summary: "档案中缺少已确认技能证据" }],
    scoringVersion: "job-match-v1",
    profileRevision: 7,
    expectationRevision: 1,
    postingContentHash: postingValue.contentHash,
    stale: false
  };
}

function setup() {
  const database = new Database(":memory:");
  migrateDatabase(database);
  return { database, repository: createJobMatchRepository(database) };
}

describe("job match repository", () => {
  it("creates and reloads a session with an immutable expectation snapshot", () => {
    const { database, repository } = setup();
    const created = repository.create({
      id: "session-1",
      initialUrl: "https://jobs.example.test/jobs",
      state: "created",
      profileRevision: 7,
      expectation,
      createdAt: "2026-08-16T00:00:00.000Z"
    });

    const reloaded = createJobMatchRepository(database).get(created.id);

    expect(created).toMatchObject({ id: "session-1", version: 0, expectationRevision: 1 });
    expect(reloaded).toMatchObject({
      id: "session-1",
      version: 0,
      state: "created",
      expectation,
      postings: [],
      results: [],
      events: []
    });
    database.close();
  });

  it("creates adapter metadata at version zero and atomically appends a confirmed expectation", () => {
    const { database, repository } = setup();
    const created = repository.create({
      id: "session-1",
      initialUrl: "https://jobs.example.test/jobs",
      state: "awaiting_filter_confirmation",
      entryKind: "job_list",
      source: "moka",
      adapterVersion: "moka-job-v1",
      executionEpoch: 4,
      profileRevision: 7,
      expectation,
      createdAt: "2026-08-16T00:00:00.000Z"
    });
    const confirmed: JobExpectationSnapshot = {
      revision: 2,
      criteria: [{ kind: "location", values: ["上海"], strength: "required" }],
      confirmedAt: "2026-08-16T00:02:00.000Z"
    };

    expect(created).toMatchObject({
      version: 0,
      entryKind: "job_list",
      source: "moka",
      adapterVersion: "moka-job-v1",
      executionEpoch: 4
    });
    expect(repository.confirmExpectation("session-1", 0, confirmed)).toMatchObject({
      version: 1,
      state: "extracting_jobs",
      expectationRevision: 2
    });
    expect(repository.get("session-1", { required: true }).expectation).toEqual(confirmed);
    expect(() => repository.confirmExpectation("session-1", 0, {
      ...confirmed,
      criteria: [{ kind: "location", values: ["北京"], strength: "required" }]
    })).toThrow("job_match_version_conflict");
    database.close();
  });

  it("reuses the immutable expectation snapshot when confirmation keeps the same revision", () => {
    const { database, repository } = setup();
    repository.create({
      id: "session-1",
      initialUrl: "https://jobs.example.test/jobs",
      state: "awaiting_filter_confirmation",
      entryKind: "job_list",
      source: "moka",
      adapterVersion: "moka-job-v1",
      profileRevision: 7,
      expectation,
      createdAt: "2026-08-16T00:00:00.000Z"
    });

    expect(repository.confirmExpectation("session-1", 0, expectation)).toMatchObject({
      version: 1,
      state: "extracting_jobs",
      expectationRevision: expectation.revision
    });
    expect(repository.get("session-1", { required: true }).expectation).toEqual(expectation);
    database.close();
  });

  it("rejects a different expectation payload that reuses an immutable revision", () => {
    const { database, repository } = setup();
    repository.create({
      id: "session-1",
      initialUrl: "https://jobs.example.test/jobs",
      state: "awaiting_filter_confirmation",
      profileRevision: 7,
      expectation,
      createdAt: "2026-08-16T00:00:00.000Z"
    });

    expect(() => repository.confirmExpectation("session-1", 0, {
      ...expectation,
      confirmedAt: "2026-08-16T00:01:00.000Z"
    })).toThrow("job_match_expectation_conflict");
    expect(repository.get("session-1", { required: true }).version).toBe(0);
    expect(repository.get("session-1", { required: true }).expectation).toEqual(expectation);
    database.close();
  });

  it("uses optimistic concurrency without overwriting a newer session", () => {
    const { database, repository } = setup();
    repository.create({
      id: "session-1",
      initialUrl: "https://jobs.example.test/jobs",
      state: "created",
      profileRevision: 7,
      expectation,
      createdAt: "2026-08-16T00:00:00.000Z"
    });

    const updated = repository.mutate("session-1", 0, (session) => ({
      ...session,
      state: "awaiting_filter_confirmation",
      entryKind: "job_list",
      source: "moka",
      adapterVersion: "moka-job-v1"
    }));

    expect(updated.version).toBe(1);
    expect(() => repository.mutate("session-1", 0, (session) => session))
      .toThrow("job_match_version_conflict");
    expect(() => repository.get("missing-session", { required: true }))
      .toThrow("job_match_session_not_found");
    database.close();
  });

  it("saves each extraction page atomically and ignores an idempotent replay", () => {
    const { database, repository } = setup();
    repository.create({
      id: "session-1",
      initialUrl: "https://jobs.example.test/jobs",
      state: "extracting_jobs",
      profileRevision: 7,
      expectation,
      createdAt: "2026-08-16T00:00:00.000Z"
    });
    const page = {
      sessionId: "session-1",
      idempotencyKey: "page-1",
      postings: [posting()],
      cursor: {
        value: "2",
        pagesRead: 1,
        elapsedMs: 500,
        newJobs: 1,
        consecutiveNoNewPages: 0
      },
      event: { type: "extraction_page_saved", payload: { page: 1, newJobs: 1 } },
      createdAt: "2026-08-16T00:01:00.000Z"
    };

    expect(repository.saveExtractionPage(page)).toEqual({ replayed: false, newJobs: 1 });
    expect(repository.saveExtractionPage(page)).toEqual({ replayed: true, newJobs: 0 });

    const reloaded = createJobMatchRepository(database).get("session-1", { required: true });
    expect(reloaded.postings).toEqual([posting()]);
    expect(reloaded.cursor).toMatchObject({ value: "2", pagesRead: 1, newJobs: 1 });
    expect(reloaded.events).toHaveLength(1);
    database.close();
  });

  it("rolls back postings and events when cursor persistence fails", () => {
    const { database, repository } = setup();
    repository.create({
      id: "session-1",
      initialUrl: "https://jobs.example.test/jobs",
      state: "extracting_jobs",
      profileRevision: 7,
      expectation,
      createdAt: "2026-08-16T00:00:00.000Z"
    });

    expect(() => repository.saveExtractionPage({
      sessionId: "session-1",
      idempotencyKey: "invalid-page",
      postings: [posting()],
      cursor: { value: "2", pagesRead: -1, elapsedMs: 0, newJobs: 1, consecutiveNoNewPages: 0 },
      event: { type: "extraction_page_saved", payload: { page: 1 } },
      createdAt: "2026-08-16T00:01:00.000Z"
    })).toThrow();
    const reloaded = repository.get("session-1", { required: true });
    expect(reloaded).toMatchObject({ postings: [], events: [] });
    expect(reloaded.cursor).toBeUndefined();
    database.close();
  });

  it("persists deterministic results and marks prior results stale", () => {
    const { database, repository } = setup();
    const postingValue = posting();
    repository.create({
      id: "session-1",
      initialUrl: "https://jobs.example.test/jobs",
      state: "matching_jobs",
      profileRevision: 7,
      expectation,
      createdAt: "2026-08-16T00:00:00.000Z"
    });
    repository.saveExtractionPage({
      sessionId: "session-1",
      idempotencyKey: "page-1",
      postings: [postingValue],
      cursor: { value: "done", pagesRead: 1, elapsedMs: 500, newJobs: 1, consecutiveNoNewPages: 0 },
      event: { type: "extraction_page_saved", payload: { page: 1 } },
      createdAt: "2026-08-16T00:01:00.000Z"
    });

    repository.saveResults("session-1", [result(postingValue)], "2026-08-16T00:02:00.000Z");
    expect(repository.get("session-1", { required: true }).results[0]?.stale).toBe(false);

    expect(repository.markResultsStale("session-1")).toBe(1);
    expect(createJobMatchRepository(database).get("session-1", { required: true }).results[0]?.stale).toBe(true);
    database.close();
  });

  it("round-trips current score breakdowns and legacy results without one", () => {
    const { database, repository } = setup();
    const legacyPosting = posting();
    const currentPosting: JobPosting = {
      ...posting("posting-2", "sha256:posting-2"),
      sourceJobId: "job-1002",
      canonicalUrl: "https://jobs.example.test/jobs/1002"
    };
    repository.create({
      id: "session-1",
      initialUrl: "https://jobs.example.test/jobs",
      state: "matching_jobs",
      profileRevision: 7,
      expectation,
      createdAt: "2026-08-16T00:00:00.000Z"
    });
    repository.saveExtractionPage({
      sessionId: "session-1",
      idempotencyKey: "page-with-current-and-legacy-results",
      postings: [legacyPosting, currentPosting],
      cursor: { value: "done", pagesRead: 1, elapsedMs: 500, newJobs: 2, consecutiveNoNewPages: 0 },
      event: { type: "extraction_page_saved", payload: { page: 1 } },
      createdAt: "2026-08-16T00:01:00.000Z"
    });
    const legacyResult = result(legacyPosting);
    const currentResult: JobMatchResult = {
      ...result(currentPosting),
      id: "result-2",
      fitScore: 82,
      scoreBreakdown: {
        total: 82,
        dimensions: [{
          dimension: "skill",
          label: "技能",
          earned: 82,
          available: 100,
          satisfied: 1,
          unknown: 0,
          conflict: 0
        }]
      }
    };

    repository.saveResults(
      "session-1",
      [currentResult, legacyResult],
      "2026-08-16T00:02:00.000Z"
    );

    const reloaded = createJobMatchRepository(database).get("session-1", { required: true }).results;
    expect(reloaded).toHaveLength(2);
    expect(reloaded.find((candidate) => candidate.id === currentResult.id)).toEqual(currentResult);
    const reloadedLegacy = reloaded.find((candidate) => candidate.id === legacyResult.id);
    expect(reloadedLegacy).toEqual(legacyResult);
    expect(reloadedLegacy).not.toHaveProperty("scoreBreakdown");
    database.close();
  });
});
