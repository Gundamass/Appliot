import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createSqliteTraceSink } from "./trace-sink.js";

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

describe("SQLite TraceSink", () => {
  it("persists schema-approved fields in sequence order", () => {
    const sink = createSqliteTraceSink(createDatabase());
    const first = sink.record({
      runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision",
      outcome: "accepted", reasonCode: "grounded", evidenceIds: ["fact-1"]
    });
    const second = sink.record({
      runId: "run-1", taskId: "task-1", node: "rank", kind: "node",
      outcome: "completed", reasonCode: "deterministic"
    });

    expect(first).toMatch(/^trace_[a-f0-9]{64}$/);
    expect(sink.list("run-1")).toEqual([
      expect.objectContaining({ id: first, sequence: 1, evidenceIds: ["fact-1"] }),
      expect.objectContaining({ id: second, sequence: 2, outcome: "completed" })
    ]);
  });

  it("rejects unknown or sensitive trace fields before persistence", () => {
    const database = createDatabase();
    const sink = createSqliteTraceSink(database);

    expect(() => sink.record({
      runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision",
      outcome: "accepted", reasonCode: "grounded", email: "person@example.com"
    } as never)).toThrow();
    expect(() => sink.record({
      runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision",
      outcome: "person@example.com", reasonCode: "grounded"
    })).toThrow("trace_pii_rejected");
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_trace_events").get())
      .toEqual({ count: 0 });
  });

  it("isolates sequences by run", () => {
    const sink = createSqliteTraceSink(createDatabase());
    sink.record({ runId: "run-a", taskId: "task-a", node: "a", kind: "node", outcome: "ok", reasonCode: "ok" });
    sink.record({ runId: "run-b", taskId: "task-b", node: "b", kind: "node", outcome: "ok", reasonCode: "ok" });
    expect(sink.list("run-a")[0]?.sequence).toBe(1);
    expect(sink.list("run-b")[0]?.sequence).toBe(1);
  });

  it("writes a LangSmith projection atomically when enabled", () => {
    const database = createDatabase();
    const sink = createSqliteTraceSink(database, { langSmithEnabled: true });
    const id = sink.record({
      runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision",
      outcome: "accepted", reasonCode: "grounded", evidenceIds: ["evidence-1"]
    });

    expect(database.prepare("SELECT trace_id, status FROM langsmith_trace_outbox").all())
      .toEqual([{ trace_id: id, status: "pending" }]);
  });
});
