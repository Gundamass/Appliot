import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGraphState } from "@resume/contracts";
import { migrateDatabase } from "../db/migrate.js";
import { BrowserOwnershipLease } from "../browser/browser-ownership-lease.js";
import { createApplicationTaskRepository } from "./application-task-repository.js";
import { createGraphApplicationReviewRepository } from "./graph-application-review-repository.js";
import { createGraphApplicationService } from "./graph-application-service.js";

const databases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const database = new Database(":memory:");
  migrateDatabase(database);
  databases.push(database);
  return database;
}

function applicationState(input: Partial<AgentGraphState> = {}): AgentGraphState {
  return {
    threadId: "application:task-1",
    runId: "application:task-1",
    taskId: "task-1",
    graphVersion: "agent-v1",
    status: "interrupted",
    profileRevision: 4,
    currentSubgraph: "application",
    application: {
      applicationUrl: "https://jobs.example.test/apply",
      executionEpoch: 0,
      retryCount: 0,
      finalReviewLocked: false
    },
    pendingInterrupt: {
      id: "login-interrupt",
      kind: "login",
      reasonCode: "login_required",
      questionIds: [],
      evidenceIds: [],
      createdAt: "2026-08-22T00:00:00.000Z"
    },
    auditEventIds: [],
    ...input
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("graph content reviews", () => {
  it("validates a reviewed draft before approving and resuming its graph interrupt", async () => {
    const database = createDatabase();
    const repository = createApplicationTaskRepository(database);
    repository.create({ id: "task-1", applicationUrl: "https://jobs.example.test/apply" });
    const reviews = createGraphApplicationReviewRepository(database);
    reviews.save(contentReview());
    const graph = {
      start: vi.fn(),
      run: vi.fn(),
      resume: vi.fn(async () => applicationState({
        status: "completed",
        pendingInterrupt: undefined,
        application: {
          applicationUrl: "https://jobs.example.test/apply",
          executionEpoch: 1,
          retryCount: 0,
          finalReviewLocked: true
        }
      })),
      state: vi.fn(async () => contentReviewState()),
      cancel: vi.fn(),
      traces: vi.fn(() => [])
    };
    const service = createGraphApplicationService({
      taskRepository: repository,
      graph,
      profileRevision: () => 4,
      browserOwnershipLease: new BrowserOwnershipLease(),
      browser: { async open() {} },
      reviewRepository: reviews,
      validateContentReview: (_review, draft) => draft === "Unsupported change" ? ["unsupported"] : []
    });

    expect(service.contentReview("task-1")).toMatchObject({ id: "content-review-1", draft: "Grounded draft" });
    await expect(service.approveReview("task-1", "content-review-1", "Unsupported change"))
      .rejects.toThrow("content_review_unsupported_edit");
    expect(reviews.find("task-1", "content-review-1")).toMatchObject({ status: "needs_review" });

    await service.approveReview("task-1", "content-review-1");

    expect(graph.resume).toHaveBeenCalledWith("application:task-1", {
      interruptId: "content-review-1",
      action: "approve",
      values: {}
    });
    expect(reviews.approvedValue("task-1", "self-evaluation")).toBe("Grounded draft");
  });

  it("removes a rejected review only after the graph transitions to failed", async () => {
    const database = createDatabase();
    const repository = createApplicationTaskRepository(database);
    repository.create({ id: "task-1", applicationUrl: "https://jobs.example.test/apply" });
    const reviews = createGraphApplicationReviewRepository(database);
    reviews.save(contentReview());
    const graph = {
      start: vi.fn(),
      run: vi.fn(),
      resume: vi.fn(async () => applicationState({
        status: "failed",
        pendingInterrupt: undefined,
        error: { code: "content_review_rejected", retryable: false, node: "content_review_rejected" }
      })),
      state: vi.fn(async () => contentReviewState()),
      cancel: vi.fn(),
      traces: vi.fn(() => [])
    };
    const service = createGraphApplicationService({
      taskRepository: repository,
      graph,
      profileRevision: () => 4,
      browserOwnershipLease: new BrowserOwnershipLease(),
      browser: { async open() {} },
      reviewRepository: reviews,
      validateContentReview: () => []
    });

    await service.rejectReview("task-1", "content-review-1");

    expect(graph.resume).toHaveBeenCalledWith("application:task-1", {
      interruptId: "content-review-1",
      action: "reject",
      values: {}
    });
    expect(reviews.find("task-1", "content-review-1")).toBeUndefined();
    expect(service.state("task-1").value).toBe("failed");
  });
});

function contentReviewState(): AgentGraphState {
  return applicationState({
    pendingInterrupt: {
      id: "content-review-1",
      kind: "content_review",
      reasonCode: "content_review_required",
      questionIds: ["field:self-evaluation"],
      evidenceIds: ["evidence-1"],
      createdAt: "2026-08-22T00:00:00.000Z"
    }
  });
}

function contentReview() {
  return {
    id: "content-review-1",
    taskId: "task-1",
    interruptId: "content-review-1",
    fieldId: "self-evaluation",
    fieldLabel: "Self evaluation",
    original: "Grounded original",
    draft: "Grounded draft",
    reasons: ["Human approval is required before filling generated content."],
    evidence: [{ documentId: "resume-1", page: 1, text: "Grounded original", extraction: "pdf_text" as const }],
    unsupportedClaims: [],
    status: "needs_review" as const
  };
}

function reviewDependencies(database: Database.Database) {
  return {
    reviewRepository: createGraphApplicationReviewRepository(database),
    validateContentReview: () => []
  };
}

describe("graph application service", () => {
  it("opens the browser before starting the application graph", async () => {
    const database = createDatabase();
    const repository = createApplicationTaskRepository(database);
    repository.create({ id: "task-1", applicationUrl: "https://jobs.example.test/apply" });
    const events: string[] = [];
    const graph = {
      start: vi.fn(async (input: unknown) => {
        events.push("graph:start");
        return applicationState();
      }),
      run: vi.fn(),
      resume: vi.fn(),
      state: vi.fn(async () => undefined),
      cancel: vi.fn(),
      traces: vi.fn(() => [])
    };
    const service = createGraphApplicationService({
      taskRepository: repository,
      graph,
      profileRevision: () => 4,
      browserOwnershipLease: new BrowserOwnershipLease(),
      browser: {
        async open() {
          events.push("browser:open");
        }
      },
      ...reviewDependencies(database)
    });

    service.start({ taskId: "task-1", applicationUrl: "https://jobs.example.test/apply" });
    await service.openBrowser("task-1");
    await service.runUntilPause("task-1");

    expect(events).toEqual(["browser:open", "graph:start"]);
    expect(graph.start).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "application:task-1",
      runId: "application:task-1",
      taskId: "task-1",
      subgraph: "application",
      profileRevision: 4,
      application: {
        applicationUrl: "https://jobs.example.test/apply",
        executionEpoch: 0,
        retryCount: 0,
        finalReviewLocked: false
      }
    }));
    expect(service.state("task-1").value).toBe("awaiting_login");
  });

  it("restores a graph-owned interrupt after reopening the browser", async () => {
    const database = createDatabase();
    const repository = createApplicationTaskRepository(database);
    repository.create({ id: "task-1", applicationUrl: "https://jobs.example.test/apply" });
    const graph = {
      start: vi.fn(),
      run: vi.fn(),
      resume: vi.fn(),
      state: vi.fn(async () => applicationState()),
      cancel: vi.fn(),
      traces: vi.fn(() => [])
    };
    const service = createGraphApplicationService({
      taskRepository: repository,
      graph,
      profileRevision: () => 4,
      browserOwnershipLease: new BrowserOwnershipLease(),
      browser: { async open() {} },
      ...reviewDependencies(database)
    });

    await service.openBrowser("task-1");

    expect(graph.start).not.toHaveBeenCalled();
    expect(service.state("task-1").value).toBe("awaiting_login");
  });

  it("emits redacted browser activity for a graph-owned task", async () => {
    const database = createDatabase();
    const repository = createApplicationTaskRepository(database);
    repository.create({ id: "task-1", applicationUrl: "https://jobs.example.test/apply" });
    const taskEvents = { emit: vi.fn(), emitProgress: vi.fn() };
    const graph = {
      start: vi.fn(),
      run: vi.fn(),
      resume: vi.fn(),
      state: vi.fn(async () => applicationState()),
      cancel: vi.fn(),
      traces: vi.fn(() => [])
    };
    const service = createGraphApplicationService({
      taskRepository: repository,
      graph,
      profileRevision: () => 4,
      browserOwnershipLease: new BrowserOwnershipLease(),
      browser: { async open() {} },
      taskEvents,
      ...reviewDependencies(database)
    });

    await service.handleActivity({ type: "page_changed", taskId: "task-1" });

    expect(taskEvents.emitProgress).toHaveBeenCalledWith("task-1", {
      type: "browser_activity",
      activity: { kind: "page_changed", displayCategory: "页面状态" }
    });
  });
});
