import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { SqliteAgentCheckpointer } from "./sqlite-checkpointer.js";
import { createSqliteTraceSink } from "./trace-sink.js";
import { createGraphService } from "./graph-service.js";
import type { SubgraphPortResult } from "./main-graph.js";

const databases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const database = new Database(":memory:");
  migrateDatabase(database);
  databases.push(database);
  return database;
}

const interruptFixture = {
  id: "interrupt-1",
  kind: "missing_fact" as const,
  reasonCode: "profile_fact_required",
  questionIds: ["question-1"],
  evidenceIds: ["evidence-1"],
  createdAt: "2026-08-22T00:00:00.000Z"
};

function startInput(threadId: string, subgraph: "resume_ingestion" | "job_matching" | "application" = "resume_ingestion") {
  return {
    threadId,
    runId: `run-${threadId}`,
    taskId: `task-${threadId}`,
    subgraph,
    profileRevision: 0
  } as const;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("main LangGraph", () => {
  it("routes to one subgraph and resumes the same checkpoint", async () => {
    const runner = vi.fn(async ({ resume }: { resume?: unknown }) => resume === undefined
      ? { status: "interrupted" as const, currentNode: "collect_missing_fact", pendingInterrupt: interruptFixture }
      : { status: "completed" as const, currentNode: "resume_complete" });
    const database = createDatabase();
    const service = createGraphService({
      checkpointer: new SqliteAgentCheckpointer(database),
      traceSink: createSqliteTraceSink(database),
      resumeIngestion: runner
    });

    const first = await service.start(startInput("thread-1"));
    expect(first.status).toBe("interrupted");
    expect(first.pendingInterrupt?.id).toBe(interruptFixture.id);
    expect(first.currentNode).toBe("collect_missing_fact");
    expect(service.traces("thread-1")).toEqual([
      expect.objectContaining({ kind: "interrupt", reasonCode: "profile_fact_required" })
    ]);

    const second = await service.resume("thread-1", {
      interruptId: interruptFixture.id,
      action: "confirm",
      values: { name: "candidate" }
    });

    expect(second.status).toBe("completed");
    expect(second.threadId).toBe("thread-1");
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      resume: expect.objectContaining({ interruptId: interruptFixture.id })
    }));
  });

  it("rejects mismatched and duplicate resumes without invoking the subgraph", async () => {
    const runner = vi.fn(async (): Promise<SubgraphPortResult> => ({
      status: "interrupted",
      pendingInterrupt: interruptFixture
    }));
    const database = createDatabase();
    const service = createGraphService({
      checkpointer: new SqliteAgentCheckpointer(database),
      traceSink: createSqliteTraceSink(database),
      resumeIngestion: runner
    });

    await service.start(startInput("thread-1"));
    await expect(service.resume("thread-1", {
      interruptId: "wrong-interrupt",
      action: "confirm",
      values: {}
    })).rejects.toThrow("agent_resume_interrupt_mismatch");
    expect(runner).toHaveBeenCalledTimes(1);

    runner.mockResolvedValueOnce({ status: "completed" });
    await service.resume("thread-1", {
      interruptId: interruptFixture.id,
      action: "confirm",
      values: {}
    });
    await expect(service.resume("thread-1", {
      interruptId: interruptFixture.id,
      action: "confirm",
      values: {}
    })).rejects.toThrow("agent_resume_not_pending");
  });

  it("keeps checkpoint state isolated by thread and namespace", async () => {
    const runner = vi.fn(async ({ resume }: { resume?: unknown }) => resume === undefined
      ? { status: "interrupted" as const, pendingInterrupt: { ...interruptFixture, id: "interrupt-shared" } }
      : { status: "completed" as const });
    const database = createDatabase();
    const service = createGraphService({
      checkpointer: new SqliteAgentCheckpointer(database),
      traceSink: createSqliteTraceSink(database),
      resumeIngestion: runner
    });

    await service.start(startInput("thread-a"));
    await service.start(startInput("thread-b"));
    expect((await service.state("thread-a"))?.taskId).toBe("task-thread-a");
    expect((await service.state("thread-b"))?.taskId).toBe("task-thread-b");

    await service.resume("thread-a", {
      interruptId: "interrupt-shared",
      action: "confirm",
      values: {}
    });
    expect((await service.state("thread-b"))?.status).toBe("interrupted");
    expect((await service.state("thread-a"))?.status).toBe("completed");
  });

  it("adopts the profile revision published by resume ingestion", async () => {
    const runner = vi.fn(async (): Promise<SubgraphPortResult> => ({
      status: "completed",
      currentNode: "check_completeness",
      resumeIngestion: {
        documentId: "document-1",
        documentFingerprint: "a".repeat(64),
        pageSources: ["pdf"],
        candidateFactIds: ["fact-1"],
        acceptedFactIds: ["fact-1"],
        publishedProfileRevision: 3
      }
    }));
    const database = createDatabase();
    const service = createGraphService({
      checkpointer: new SqliteAgentCheckpointer(database),
      traceSink: createSqliteTraceSink(database),
      resumeIngestion: runner
    });

    const state = await service.start(startInput("thread-profile-revision"));

    expect(state.profileRevision).toBe(3);
    expect(state.resumeIngestion?.publishedProfileRevision).toBe(3);
  });

  it("invalidates application execution before persisting cancellation", async () => {
    const order: string[] = [];
    const runner = vi.fn(async () => ({ status: "interrupted" as const, pendingInterrupt: {
      ...interruptFixture,
      id: "challenge-1",
      kind: "challenge" as const,
      reasonCode: "challenge_detected"
    } }));
    const database = createDatabase();
    const service = createGraphService({
      checkpointer: new SqliteAgentCheckpointer(database),
      traceSink: createSqliteTraceSink(database),
      application: runner,
      invalidateExecutionEpoch: async () => { order.push("invalidate"); }
    });

    await service.start(startInput("thread-app", "application"));
    const cancelled = await service.cancel("thread-app");

    order.push("cancelled");
    expect(cancelled.status).toBe("cancelled");
    expect(order).toEqual(["invalidate", "cancelled"]);
    expect((await service.state("thread-app"))?.pendingInterrupt).toBeUndefined();
  });
});
