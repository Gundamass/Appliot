import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationService } from "./application-service.js";
import type { ApplicationProgressSnapshot } from "./application-progress.js";
import { createApplicationTaskRepository } from "./application-task-repository.js";
import { createApplicationServiceRouter } from "./application-service-router.js";
import { migrateDatabase } from "../db/migrate.js";

const databases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const database = new Database(":memory:");
  migrateDatabase(database);
  databases.push(database);
  return database;
}

function applicationService(value: "created" | "awaiting_login"): ApplicationService {
  return {
    start: vi.fn(),
    activeBrowserTaskId: vi.fn(() => undefined),
    state: vi.fn(() => ({
      value,
      context: { taskId: "task", applicationUrl: "https://jobs.example.test/apply", questions: [], errors: [] }
    })),
    requiresRecovery: vi.fn(() => false),
    openBrowser: vi.fn(),
    resume: vi.fn(),
    resumeAfterChallenge: vi.fn(),
    resumeWithProfile: vi.fn(),
    refreshFromProfile: vi.fn(),
    syncTaskFromProfile: vi.fn(),
    answerQuestions: vi.fn(),
    contentReview: vi.fn(() => undefined),
    fieldCoverage: vi.fn(() => undefined),
    approveReview: vi.fn(),
    rejectReview: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
    runUntilPause: vi.fn(),
    requestIntermediateClick: vi.fn(),
    progress: vi.fn((): ApplicationProgressSnapshot => ({
      status: "idle",
      busy: false,
      generation: 0,
      retryCount: 0,
      recovery: []
    })),
    recoveryCommands: vi.fn(() => []),
    handleActivity: vi.fn(),
    retryCurrent: vi.fn(),
    manualDone: vi.fn()
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("application service router", () => {
  it("routes legacy and graph-owned tasks by their persisted orchestrator", () => {
    const database = createDatabase();
    const tasks = createApplicationTaskRepository(database);
    database.prepare(`
      INSERT INTO application_tasks (id, name, application_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      "legacy-task",
      "Legacy",
      "https://jobs.example.test/legacy",
      "2026-08-22T00:00:00.000Z",
      "2026-08-22T00:00:00.000Z"
    );
    tasks.create({ id: "graph-task", applicationUrl: "https://jobs.example.test/graph" });
    const legacy = applicationService("created");
    const graph = applicationService("awaiting_login");
    const routed = createApplicationServiceRouter({ taskRepository: tasks, legacy, graph });

    expect(routed.state("legacy-task").value).toBe("created");
    expect(routed.state("graph-task").value).toBe("awaiting_login");

    expect(legacy.state).toHaveBeenCalledWith("legacy-task");
    expect(graph.state).toHaveBeenCalledWith("graph-task");
  });

  it("keeps a direct non-persisted start on the legacy service", async () => {
    const database = createDatabase();
    const tasks = createApplicationTaskRepository(database);
    const legacy = applicationService("created");
    const graph = applicationService("awaiting_login");
    const routed = createApplicationServiceRouter({ taskRepository: tasks, legacy, graph });

    routed.start({ taskId: "direct-task", applicationUrl: "https://jobs.example.test/direct" });
    await routed.openBrowser("direct-task");

    expect(legacy.start).toHaveBeenCalledWith({
      taskId: "direct-task",
      applicationUrl: "https://jobs.example.test/direct"
    });
    expect(legacy.openBrowser).toHaveBeenCalledWith("direct-task");
    expect(graph.start).not.toHaveBeenCalled();
    expect(graph.openBrowser).not.toHaveBeenCalled();
  });
});
