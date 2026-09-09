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
    })).toThrow();
    expect(() => sink.record({
      runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision",
      outcome: "https://talent.baidu.com/apply?token=secret", reasonCode: "grounded"
    })).toThrow();
    expect(() => sink.record({
      runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision",
      outcome: "accepted", reasonCode: "grounded", candidateIds: ["candidate@example.com"]
    })).toThrow();
    expect(() => sink.record({
      runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision",
      outcome: "accepted", reasonCode: "grounded", evidenceIds: ["input[name=email]"]
    })).toThrow();
    expect(() => sink.record({
      runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision",
      outcome: "accepted", reasonCode: "approval_token_secret"
    })).toThrow();
    expect(() => sink.record({
      runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision",
      outcome: "accepted", reasonCode: "sk-proj-abc123"
    })).toThrow();
    expect(() => sink.record({
      runId: "run-1", taskId: "task-1", node: "judge", kind: "tool_call",
      outcome: "accepted", reasonCode: "grounded", toolName: "sk-proj-abc123"
    })).toThrow();
    expect(() => sink.record({
      runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision",
      outcome: "accepted", reasonCode: "grounded",
      candidateIds: ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5kaWRhdGUifQ.signature123"]
    })).toThrow();
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

  it("does not mistake a phone-looking substring inside an opaque UUID for PII", () => {
    const sink = createSqliteTraceSink(createDatabase());
    const taskId = "72b3f53c-3cde-5953-a9d9-17245782939e";

    expect(() => sink.record({
      runId: `application-target:${taskId}`,
      taskId,
      node: "application_target_job_match",
      kind: "checkpoint",
      outcome: "prepared",
      reasonCode: "explicit"
    })).not.toThrow();
    expect(() => sink.record({
      runId: "run-phone",
      taskId: "task-phone",
      node: "judge",
      kind: "model_decision",
      outcome: "accepted",
      reasonCode: "grounded",
      candidateIds: ["17245782939"]
    })).toThrow("trace_pii_rejected");
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

  it("persists and projects only safe Skill dimensions", () => {
    const database = createDatabase();
    const sink = createSqliteTraceSink(database, { langSmithEnabled: true });
    const skill = {
      skillId: "baidu-campus-application",
      skillVersion: "1.0.0",
      pageFingerprintHash: "b".repeat(64),
      pageVariantId: "application-form",
      allocation: "champion" as const
    };

    sink.record({
      runId: "run-1", taskId: "task-1", node: "execute_plan", kind: "tool_call",
      outcome: "completed", reasonCode: "command_applied", skill
    });

    expect(sink.list("run-1")[0]).toMatchObject({ skill });
    const payload = database.prepare("SELECT payload_json FROM langsmith_trace_outbox").get() as { payload_json: string };
    expect(JSON.parse(payload.payload_json)).toMatchObject({ skill });
    expect(payload.payload_json).not.toContain("token=");
  });
});
