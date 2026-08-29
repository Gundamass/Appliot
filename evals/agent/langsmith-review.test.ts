import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../../apps/api/src/db/migrate.js";
import { createLangSmithExporter } from "../../apps/api/src/agent/langsmith-exporter.js";
import { createSqliteLangSmithOutbox, projectLangSmithEvent } from "../../apps/api/src/agent/langsmith-outbox.js";
import {
  assertTraceProjectionCorrelation,
  projectReviewTrace,
  assertPrivacySafe
} from "./run-evals.js";

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

describe("LangSmith review gate", () => {
  it("preserves parentage, order, versions, and terminal outcome", () => {
    const local = [
      projectReviewTrace({
        runId: "run-root", sequence: 1, node: "route", graphVersion: "agent-v1",
        modelVersion: "none", toolVersion: "router-v1", retrievalVersion: "none", outcome: "started"
      }),
      projectReviewTrace({
        runId: "run-child", parentRunId: "run-root", sequence: 2, node: "judge",
        graphVersion: "agent-v1", modelVersion: "deepseek-v1", toolVersion: "advisor-v1",
        retrievalVersion: "lightrag-v1", outcome: "accepted"
      }),
      projectReviewTrace({
        runId: "run-root", sequence: 3, node: "terminal", graphVersion: "agent-v1",
        modelVersion: "none", toolVersion: "router-v1", retrievalVersion: "none", outcome: "completed"
      })
    ];
    const projected = local.map(projectReviewTrace);

    expect(() => assertTraceProjectionCorrelation(local, projected)).not.toThrow();
    expect(projected[1]).toEqual(expect.objectContaining({
      parentRunIdHash: expect.any(String), sequence: 2, modelVersion: "deepseek-v1",
      retrievalVersion: "lightrag-v1", outcome: "accepted"
    }));
  });

  it.each(["Ada Example", "13800138000", "person@example.com", "<div>secret</div>"]) (
    "rejects raw sensitive value %s before export",
    (value) => {
      expect(() => assertPrivacySafe({ value })).toThrow("trace_pii_rejected");
    }
  );

  it("isolates timeout, rate-limit, authentication, duplicate flush, and dead letter", async () => {
    const timeoutOutbox = createSqliteLangSmithOutbox(createDatabase(), { maxAttempts: 2 });
    timeoutOutbox.enqueue("trace-timeout", projectLangSmithEvent({
      runId: "run-timeout", taskId: "task-1", node: "node", kind: "node",
      outcome: "failed", reasonCode: "timeout"
    }));
    const timeoutExporter = createLangSmithExporter({
      outbox: timeoutOutbox,
      client: { createRun: vi.fn().mockRejectedValue(new Error("timeout")) },
      maxAttempts: 2
    });
    await expect(timeoutExporter.flushOnce()).resolves.toEqual({ sent: 0, retried: 1, deadLetter: 0 });

    const rateOutbox = createSqliteLangSmithOutbox(createDatabase(), { maxAttempts: 2 });
    rateOutbox.enqueue("trace-rate", projectLangSmithEvent({
      runId: "run-rate", taskId: "task-1", node: "node", kind: "node",
      outcome: "failed", reasonCode: "rate_limit"
    }));
    const rateExporter = createLangSmithExporter({
      outbox: rateOutbox,
      client: { createRun: vi.fn().mockRejectedValue(new Error("429 rate limit")) },
      maxAttempts: 2
    });
    await rateExporter.flushOnce();
    expect(rateOutbox.list()[0]?.lastErrorCode).toBe("rate_limit");

    const authOutbox = createSqliteLangSmithOutbox(createDatabase(), { maxAttempts: 1 });
    authOutbox.enqueue("trace-auth", projectLangSmithEvent({
      runId: "run-auth", taskId: "task-1", node: "node", kind: "node",
      outcome: "failed", reasonCode: "authentication"
    }));
    const authExporter = createLangSmithExporter({
      outbox: authOutbox,
      client: { createRun: vi.fn().mockRejectedValue(new Error("401 authentication")) },
      maxAttempts: 1
    });
    await expect(authExporter.flushOnce()).resolves.toEqual({ sent: 0, retried: 0, deadLetter: 1 });

    const duplicateOutbox = createSqliteLangSmithOutbox(createDatabase());
    const event = projectLangSmithEvent({
      runId: "run-duplicate", taskId: "task-1", node: "node", kind: "node",
      outcome: "completed", reasonCode: "ok"
    });
    duplicateOutbox.enqueue("trace-duplicate", event);
    duplicateOutbox.enqueue("trace-duplicate", event);
    const createRun = vi.fn().mockResolvedValue({ id: "remote-1" });
    const duplicateExporter = createLangSmithExporter({ outbox: duplicateOutbox, client: { createRun } });
    await duplicateExporter.flushOnce();
    await duplicateExporter.flushOnce();
    expect(createRun).toHaveBeenCalledTimes(1);
  });
});
