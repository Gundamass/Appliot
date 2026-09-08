import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { SqliteAgentCheckpointer } from "./sqlite-checkpointer.js";
import { createSqliteTraceSink } from "./trace-sink.js";
import { createGraphService } from "./graph-service.js";
import type { SubgraphPortResult } from "./main-graph.js";
import type { AgentGraphState, ApplicationExecutionState } from "@resume/contracts";

const databases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const database = new Database(":memory:");
  migrateDatabase(database);
  databases.push(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("GraphService", () => {
  it("passes application execution state into an application subgraph", async () => {
    const database = createDatabase();
    const application: ApplicationExecutionState = {
      applicationUrl: "https://jobs.example.test/apply",
      executionEpoch: 0,
      retryCount: 0,
      finalReviewLocked: false
    };
    const runner = vi.fn(async ({ state }: { state: AgentGraphState }): Promise<SubgraphPortResult> => ({
      status: "completed" as const,
      application: state.application
    }));
    const service = createGraphService({
      checkpointer: new SqliteAgentCheckpointer(database),
      traceSink: createSqliteTraceSink(database),
      application: runner
    });

    const result = await service.start({
      threadId: "application-thread",
      runId: "application-run",
      taskId: "application-task",
      subgraph: "application",
      profileRevision: 3,
      application
    });

    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({ application })
    }));
    expect(result.application).toEqual(application);
  });

  it("continues a persisted application thread using its stored subgraph", async () => {
    const database = createDatabase();
    const application: ApplicationExecutionState = {
      applicationUrl: "https://jobs.example.test/apply",
      executionEpoch: 0,
      retryCount: 0,
      finalReviewLocked: false
    };
    const first = createGraphService({
      checkpointer: new SqliteAgentCheckpointer(database),
      traceSink: createSqliteTraceSink(database),
      application: async ({ state }) => ({ status: "running" as const, application: state.application })
    });
    await first.start({
      threadId: "continue-thread",
      runId: "continue-run",
      taskId: "continue-task",
      subgraph: "application",
      profileRevision: 1,
      application
    });

    const runner = vi.fn(async ({ state }: { state: AgentGraphState }): Promise<SubgraphPortResult> => ({
      status: "completed" as const,
      application: state.application
    }));
    const resumed = createGraphService({
      checkpointer: new SqliteAgentCheckpointer(database),
      traceSink: createSqliteTraceSink(database),
      application: runner
    });

    const result = await resumed.run("continue-thread");

    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({ application })
    }));
    expect(result.status).toBe("completed");
  });

  it("recovers an interrupted task after a service restart", async () => {
    const database = createDatabase();
    const checkpointer = new SqliteAgentCheckpointer(database);
    const traceSink = createSqliteTraceSink(database);
    const firstRunner = vi.fn(async () => ({
      status: "interrupted" as const,
      pendingInterrupt: {
        id: "restart-interrupt",
        kind: "content_review" as const,
        reasonCode: "review_required",
        questionIds: [],
        evidenceIds: [],
        createdAt: "2026-08-22T00:00:00.000Z"
      }
    }));
    const first = createGraphService({ checkpointer, traceSink, resumeIngestion: firstRunner });
    await first.start({
      threadId: "restart-thread", runId: "restart-run", taskId: "restart-task",
      subgraph: "resume_ingestion", profileRevision: 2
    });

    const secondRunner = vi.fn(async ({ resume }: { resume?: unknown }) => resume === undefined
      ? { status: "interrupted" as const, pendingInterrupt: {
          id: "restart-interrupt", kind: "content_review" as const, reasonCode: "review_required",
          questionIds: [], evidenceIds: [], createdAt: "2026-08-22T00:00:00.000Z"
        } }
      : { status: "completed" as const });
    const second = createGraphService({ checkpointer, traceSink, resumeIngestion: secondRunner });

    expect((await second.state("restart-thread"))?.status).toBe("interrupted");
    const result = await second.resume("restart-thread", {
      interruptId: "restart-interrupt", action: "approve", values: {}
    });
    expect(result.status).toBe("completed");
    expect(secondRunner).toHaveBeenCalledTimes(1);
  });

  it("exposes a safe state snapshot and trace list for a thread", async () => {
    const database = createDatabase();
    const service = createGraphService({
      checkpointer: new SqliteAgentCheckpointer(database),
      traceSink: createSqliteTraceSink(database),
      jobMatching: async () => ({ status: "completed" as const })
    });

    const result = await service.start({
      threadId: "job-thread", runId: "job-run", taskId: "job-task",
      subgraph: "job_matching", profileRevision: 1
    });

    expect(result).toEqual(expect.objectContaining({
      threadId: "job-thread", currentSubgraph: "job_matching", status: "completed"
    }));
    expect(service.traces("job-thread").every((event) => !("values" in event))).toBe(true);
  });
});
