import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { SqliteAgentCheckpointer } from "./sqlite-checkpointer.js";
import { createSqliteTraceSink } from "./trace-sink.js";
import { createGraphService } from "./graph-service.js";

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
