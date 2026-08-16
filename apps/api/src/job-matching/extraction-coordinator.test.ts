import Database from "better-sqlite3";
import type {
  FilterPlan,
  JobExpectationSnapshot,
  JobMatchMutationGuard,
  JobPageSnapshot
} from "@resume/contracts";
import { mokaJobAdapter, type JobAdapter } from "@resume/job-matching";
import { describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createExtractionCoordinator } from "./extraction-coordinator.js";
import { createJobMatchRepository, type JobMatchRepository } from "./job-match-repository.js";

const expectation: JobExpectationSnapshot = {
  revision: 2,
  confirmedAt: "2026-08-16T00:00:00.000Z",
  criteria: [{ kind: "location", values: ["深圳"], strength: "preferred" }]
};

const guard: JobMatchMutationGuard = { sessionVersion: 1, idempotencyKey: "confirm-1" };

function page(id: string, jobId: string, options: { hasNext?: boolean; nextCursor?: string } = {}): JobPageSnapshot {
  return {
    id,
    ownerId: "session-1",
    url: "https://app.mokahr.com/social-recruitment/example/1#/jobs",
    title: "职位列表",
    capturedAt: "2026-08-16T00:00:00.000Z",
    entryHint: "job_list",
    visibleText: ["职位列表"],
    jobCards: [{
      sourceJobId: jobId,
      canonicalUrl: `https://app.mokahr.com/social-recruitment/example/1#/job/${jobId}`,
      title: `Java 工程师 ${jobId}`,
      organization: "示例科技",
      location: "深圳",
      summary: "熟悉 Java"
    }],
    filterState: [{ key: "location", values: ["深圳"] }],
    pagination: {
      kind: options.hasNext === false ? "none" : "page",
      hasNext: options.hasNext ?? true,
      ...(options.nextCursor === undefined ? {} : { nextCursor: options.nextCursor })
    },
    boundaries: []
  };
}

function setup(state: "awaiting_filter_confirmation" | "extracting_jobs" = "extracting_jobs") {
  const database = new Database(":memory:");
  migrateDatabase(database);
  const repository = createJobMatchRepository(database);
  repository.create({
    id: "session-1",
    initialUrl: "https://app.mokahr.com/social-recruitment/example/1#/jobs",
    state,
    profileRevision: 4,
    expectation
  });
  repository.mutate("session-1", 0, (session) => ({
    ...session,
    source: "moka",
    adapterVersion: "moka-job-v1",
    executionEpoch: 7
  }));
  return { database, repository };
}

function browser(overrides: Partial<{
  observeJob(ownerId: string): Promise<JobPageSnapshot>;
  applyJobFilters(ownerId: string, plan: FilterPlan, executionEpoch: number): Promise<JobPageSnapshot>;
  advanceJobPage(ownerId: string, cursor: string | undefined, executionEpoch: number): Promise<JobPageSnapshot>;
}> = {}) {
  return {
    observeJob: vi.fn(async () => page("page-1", "job-1", { nextCursor: "page-2" })),
    applyJobFilters: vi.fn(async () => page("filtered", "job-1", { nextCursor: "page-2" })),
    advanceJobPage: vi.fn(async () => page("page-2", "job-2", { hasNext: false })),
    ...overrides
  };
}

function coordinator(repository: JobMatchRepository, browserPort: ReturnType<typeof browser>, adapter: JobAdapter = mokaJobAdapter) {
  return createExtractionCoordinator({
    repository,
    browser: browserPort,
    adapters: [adapter],
    now: vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValue(500),
    nowIso: () => "2026-08-16T00:01:00.000Z"
  });
}

describe("extraction coordinator", () => {
  it("does not write filters before confirmation and returns verified readback", async () => {
    const { database, repository } = setup("awaiting_filter_confirmation");
    const browserPort = browser();
    const subject = coordinator(repository, browserPort);
    expect(browserPort.applyJobFilters).not.toHaveBeenCalled();

    const confirmed = await subject.confirmFilters("session-1", expectation, guard);

    expect(browserPort.applyJobFilters).toHaveBeenCalledTimes(1);
    expect(browserPort.applyJobFilters).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ source: "moka", mapped: [{ criterionIndex: 0, key: "location", values: ["深圳"] }] }),
      7
    );
    expect(confirmed.snapshot.filterState).toEqual([{ key: "location", values: ["深圳"] }]);
    database.close();
  });

  it("fails a filter readback mismatch without retrying the write", async () => {
    const { database, repository } = setup("awaiting_filter_confirmation");
    const browserPort = browser({
      applyJobFilters: vi.fn(async () => ({ ...page("filtered", "job-1"), filterState: [] }))
    });

    await expect(coordinator(repository, browserPort).confirmFilters("session-1", expectation, guard))
      .rejects.toThrow("job_filter_readback_mismatch");
    expect(browserPort.applyJobFilters).toHaveBeenCalledOnce();
    database.close();
  });

  it("stops normally after two consecutive pages add no unique jobs", async () => {
    const { database, repository } = setup();
    const first = page("page-1", "job-1", { nextCursor: "page-2" });
    const duplicate = page("page-2", "job-1", { nextCursor: "page-3" });
    const duplicateAgain = page("page-3", "job-1", { nextCursor: "page-4" });
    const browserPort = browser({
      observeJob: vi.fn(async () => first),
      advanceJobPage: vi.fn()
        .mockResolvedValueOnce(duplicate)
        .mockResolvedValueOnce(duplicateAgain)
    });

    const result = await coordinator(repository, browserPort).runExtraction("session-1");

    expect(result).toMatchObject({ state: "completed", stopReason: "no_new_jobs", pagesRead: 3, newJobs: 1 });
    expect(repository.get("session-1", { required: true }).postings).toHaveLength(1);
    database.close();
  });

  it("persists partial results and pauses at the page budget", async () => {
    const { database, repository } = setup();
    const browserPort = browser();

    const result = await coordinator(repository, browserPort).runExtraction("session-1", { maxPages: 1 });

    expect(result).toMatchObject({ state: "paused", stopReason: "page_limit", pagesRead: 1, newJobs: 1 });
    expect(browserPort.advanceJobPage).not.toHaveBeenCalled();
    expect(repository.get("session-1", { required: true })).toMatchObject({
      state: "paused",
      stopReason: "page_limit",
      cursor: { value: "page-2", continuationToken: "page-2" }
    });
    database.close();
  });

  it("resumes from a persisted cursor and retries a failed read only once", async () => {
    const { database, repository } = setup();
    repository.saveExtractionPage({
      sessionId: "session-1",
      idempotencyKey: "seed-cursor",
      postings: [],
      cursor: {
        value: "page-2",
        pagesRead: 1,
        elapsedMs: 10,
        newJobs: 0,
        consecutiveNoNewPages: 0,
        continuationToken: "page-2",
        stopReason: "page_limit"
      },
      event: { type: "extraction_paused", payload: { reason: "page_limit" } }
    });
    const browserPort = browser({
      advanceJobPage: vi.fn()
        .mockRejectedValueOnce(new Error("temporary read failure"))
        .mockResolvedValueOnce(page("page-2", "job-2", { hasNext: false }))
    });

    const result = await coordinator(repository, browserPort).runExtraction("session-1");

    expect(result).toMatchObject({ state: "completed", stopReason: "complete", pagesRead: 1, newJobs: 1 });
    expect(browserPort.observeJob).not.toHaveBeenCalled();
    expect(browserPort.advanceJobPage).toHaveBeenCalledTimes(2);
    expect(browserPort.advanceJobPage).toHaveBeenCalledWith("session-1", "page-2", 7);
    database.close();
  });
});
