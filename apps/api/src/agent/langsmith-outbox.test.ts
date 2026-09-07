import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
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

const input = {
  runId: "run-1", taskId: "task-1", node: "judge", kind: "model_decision" as const,
  outcome: "accepted", reasonCode: "grounded", evidenceIds: ["evidence-1"],
  candidateIds: ["candidate-1"], confidence: 0.9, durationMs: 12
};

describe("LangSmith outbox", () => {
  it("projects only the versioned allowlist and hashes run identity", () => {
    const event = projectLangSmithEvent(input);
    expect(event).toEqual(expect.objectContaining({
      runIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      graphVersion: "agent-v1",
      nodeName: "judge",
      eventType: "model_decision",
      outcome: "accepted",
      candidateCount: 1,
      evidenceCount: 1
    }));
    expect(JSON.stringify(event)).not.toContain("candidate-1");
    expect(JSON.stringify(event)).not.toContain("evidence-1");
  });

  it("projects the bounded Skill dimensions without raw page data", () => {
    const skill = {
      skillId: "baidu-campus-application",
      skillVersion: "1.0.0",
      pageFingerprintHash: "c".repeat(64),
      pageVariantId: "application-form",
      allocation: "champion" as const
    };
    const event = projectLangSmithEvent({ ...input, skill });

    expect(event).toMatchObject({ skill });
    expect(JSON.stringify(event)).not.toContain("https://talent.baidu.com/jobs?token=secret");
  });

  it.each(["张三", "13800138000", "person@example.com", "<div>resume</div>"])(
    "rejects sensitive export value %s",
    (value) => {
      expect(() => projectLangSmithEvent({ ...input, summary: value })).toThrow("trace_pii_rejected");
    }
  );

  it("rejects credential-like tokens before creating an export event", () => {
    expect(() => projectLangSmithEvent({ ...input, reasonCode: "approval_token_secret" })).toThrow();
    expect(() => projectLangSmithEvent({ ...input, reasonCode: "sk-proj-abc123" })).toThrow();
    expect(() => projectLangSmithEvent({
      ...input,
      candidateIds: ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5kaWRhdGUifQ.signature123"]
    })).toThrow();
    expect(() => projectLangSmithEvent({
      ...input,
      skill: {
        skillId: "approval_token_secret",
        skillVersion: "1.0.0",
        pageFingerprintHash: "a".repeat(64),
        pageVariantId: "application-form",
        allocation: "champion"
      }
    })).toThrow();
  });

  it("enqueues, claims, and transitions an item to sent", () => {
    const outbox = createSqliteLangSmithOutbox(createDatabase());
    outbox.enqueue("trace-1", projectLangSmithEvent(input));
    const claimed = outbox.claim(10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.traceId).toBe("trace-1");
    outbox.markSent(claimed[0]!.id, "remote-1");
    expect(outbox.list()).toEqual([expect.objectContaining({ status: "sent", remoteRunId: "remote-1" })]);
    expect(outbox.claim(10)).toEqual([]);
  });

  it("moves an item to dead letter after the configured attempts", () => {
    const outbox = createSqliteLangSmithOutbox(createDatabase(), { maxAttempts: 2 });
    outbox.enqueue("trace-1", projectLangSmithEvent(input));
    const first = outbox.claim(1)[0]!;
    expect(outbox.markFailed(first.id, "timeout")).toEqual({ status: "pending", attempts: 1 });
    const second = outbox.claim(1, new Date(Date.now() + 5_000))[0]!;
    expect(outbox.markFailed(second.id, "timeout")).toEqual({ status: "dead_letter", attempts: 2 });
    expect(outbox.list()[0]).toEqual(expect.objectContaining({ status: "dead_letter", lastErrorCode: "timeout" }));
  });
});
