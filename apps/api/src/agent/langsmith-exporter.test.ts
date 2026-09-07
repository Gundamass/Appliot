import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createLangSmithExporter } from "./langsmith-exporter.js";
import { createSqliteLangSmithOutbox, projectLangSmithEvent } from "./langsmith-outbox.js";

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

const event = projectLangSmithEvent({
  runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision",
  outcome: "accepted", reasonCode: "grounded",
  skill: {
    skillId: "baidu-application",
    skillVersion: "1.0.0",
    pageFingerprintHash: "e".repeat(64),
    pageVariantId: "application-form",
    allocation: "champion"
  }
});

describe("LangSmith exporter", () => {
  it("keeps graph execution independent from a remote timeout", async () => {
    const outbox = createSqliteLangSmithOutbox(createDatabase());
    outbox.enqueue("trace-1", event);
    const exporter = createLangSmithExporter({
      client: { createRun: vi.fn().mockRejectedValue(new Error("timeout")) },
      outbox,
      maxAttempts: 2
    });

    await expect(exporter.flushOnce()).resolves.toEqual({ sent: 0, retried: 1, deadLetter: 0 });
    expect(outbox.list()[0]).toEqual(expect.objectContaining({
      status: "pending",
      attempts: 1,
      event: expect.objectContaining({
        skill: expect.objectContaining({ skillId: "baidu-application", allocation: "champion" })
      })
    }));
  });

  it("uses the trace id as an idempotency key and does not resend sent rows", async () => {
    const outbox = createSqliteLangSmithOutbox(createDatabase());
    outbox.enqueue("trace-1", event);
    const createRun = vi.fn().mockResolvedValue({ id: "remote-1" });
    const exporter = createLangSmithExporter({ client: { createRun }, outbox });

    await expect(exporter.flushOnce()).resolves.toEqual({ sent: 1, retried: 0, deadLetter: 0 });
    await expect(exporter.flushOnce()).resolves.toEqual({ sent: 0, retried: 0, deadLetter: 0 });
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(createRun).toHaveBeenCalledWith(event, "trace-1");
  });
});
