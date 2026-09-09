import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createCheckpointRepository } from "./checkpoint-repository.js";
import { createTaskEventBus } from "./task-events.js";
import { createApplicationTaskRepository } from "./application-task-repository.js";
import { createRuntimeApplicationStateStore } from "../agent/runtime/application-state-store.js";

const pollutedUrl = "https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440%E8%BF%99%E4%B8%AA%E9%A1%B5%E9%9D%A2%E5%8F%AF%E4%BB%A5%E6%8A%95%E9%80%92%E5%90%97";
const recoveredUrl = "https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440";

function runtimeState(runId: string, taskId: string, applicationUrl: string) {
  return {
    version: "1.1.0" as const,
    runId,
    taskId,
    applicationUrl,
    executionEpoch: 0,
    plannedCommandIds: [],
    completedCommandIds: [],
    retryCount: 0,
    finalReviewLocked: false,
    updatedAt: "2026-09-09T00:00:00.000Z"
  };
}

describe("application task repository", () => {
  it.each(["get", "list"] as const)("repairs a recovered encoded suffix atomically through %s", async (method) => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createApplicationTaskRepository(database);
    repository.create({ id: "historical-task", applicationUrl: pollutedUrl });
    const states = createRuntimeApplicationStateStore(database);
    await states.save(runtimeState("matching-run", "historical-task", pollutedUrl));
    await states.save(runtimeState("same-task-other-url", "historical-task", "https://jobs.example.test/other"));
    await states.save(runtimeState("other-task-same-url", "other-task", pollutedUrl));
    database.prepare(`
      INSERT INTO application_task_events (task_id, type, state, created_at)
      VALUES ('historical-task', 'state_changed', 'created', '2026-09-09T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO application_checkpoints (
        task_id, sequence, state, url, stage, snapshot_id, field_ids_json, questions_json, created_at
      ) VALUES ('historical-task', 1, 'created', ?, 'unknown', 'snapshot-history', '[]', '[]', '2026-09-09T00:00:00.000Z')
    `).run(pollutedUrl);
    database.prepare(`
      INSERT INTO agent_trace_events (
        id, run_id, task_id, sequence, node, kind, outcome, reason_code, payload_json, created_at
      ) VALUES ('trace-history', 'matching-run', 'historical-task', 1, 'start', 'node', 'completed', 'historical', '{}', '2026-09-09T00:00:00.000Z')
    `).run();

    const beforeHistory = {
      events: database.prepare("SELECT * FROM application_task_events").all(),
      checkpoints: database.prepare("SELECT * FROM application_checkpoints").all(),
      traces: database.prepare("SELECT * FROM agent_trace_events").all()
    };
    const result = method === "get" ? repository.get("historical-task") : repository.list()[0];

    expect(result?.applicationUrl).toBe(recoveredUrl);
    expect(database.prepare("SELECT application_url FROM application_tasks WHERE id = 'historical-task'").get())
      .toEqual({ application_url: recoveredUrl });
    await expect(states.get("matching-run")).resolves.toMatchObject({ applicationUrl: recoveredUrl });
    await expect(states.get("same-task-other-url")).resolves.toMatchObject({ applicationUrl: "https://jobs.example.test/other" });
    await expect(states.get("other-task-same-url")).resolves.toMatchObject({ applicationUrl: pollutedUrl });
    expect({
      events: database.prepare("SELECT * FROM application_task_events").all(),
      checkpoints: database.prepare("SELECT * FROM application_checkpoints").all(),
      traces: database.prepare("SELECT * FROM agent_trace_events").all()
    }).toEqual(beforeHistory);
    database.close();
  });

  it("does not rewrite valid encoded paths or legitimate Chinese query values", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createApplicationTaskRepository(database);
    const urls = [
      "https://jobs.example.test/%E6%8A%80%E6%9C%AF%E6%94%AF%E6%8C%81",
      "https://jobs.example.test/apply?candidateId=abc%E5%BC%A0%E4%B8%89"
    ];
    urls.forEach((applicationUrl, index) => repository.create({ id: `valid-${index}`, applicationUrl }));

    repository.list();
    urls.forEach((applicationUrl, index) => {
      expect(repository.get(`valid-${index}`)?.applicationUrl).toBe(applicationUrl);
    });
    database.close();
  });

  it("rolls back the task repair when a matching Runtime payload is corrupt", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createApplicationTaskRepository(database);
    repository.create({ id: "historical-task", applicationUrl: pollutedUrl });
    database.pragma("ignore_check_constraints = ON");
    database.prepare(`
      INSERT INTO agent_runtime_application_states (run_id, payload_json, updated_at)
      VALUES ('corrupt-run', ?, '2026-09-09T00:00:00.000Z')
    `).run(`{"taskId":"historical-task","applicationUrl":${JSON.stringify(pollutedUrl)}`);
    database.pragma("ignore_check_constraints = OFF");

    expect(() => repository.get("historical-task")).toThrow("runtime_application_state_corrupt");
    expect(database.prepare("SELECT application_url FROM application_tasks WHERE id = 'historical-task'").get())
      .toEqual({ application_url: pollutedUrl });
    database.close();
  });

  it("persists profile synchronization state without moving the applied revision backwards", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createApplicationTaskRepository(database);
    const task = repository.create({
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      name: "示例投递",
      applicationUrl: "https://jobs.example.test/apply"
    });

    expect(task).toMatchObject({
      profileRevisionApplied: 0,
      profileSyncStatus: "current"
    });
    repository.markProfileSyncPending(task.id);
    expect(repository.get(task.id)).toMatchObject({ profileSyncStatus: "pending" });

    repository.markProfileSyncFailed(task.id, "browser_unavailable");
    expect(repository.get(task.id)).toMatchObject({
      profileRevisionApplied: 0,
      profileSyncStatus: "failed",
      profileSyncError: "browser_unavailable"
    });

    repository.markProfileSyncSucceeded(task.id, 4);
    repository.markProfileSyncSucceeded(task.id, 2);
    const synchronized = repository.get(task.id);
    expect(synchronized).toMatchObject({
      profileRevisionApplied: 4,
      profileSyncStatus: "current"
    });
    expect(synchronized).not.toHaveProperty("profileSyncError");
    database.close();
  });

  it("persists task metadata across repository instances", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);

    const first = createApplicationTaskRepository(database);
    const task = first.create({
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      name: "示例投递",
      applicationUrl: "https://jobs.example.test/apply"
    });

    const reopened = createApplicationTaskRepository(database);
    expect(reopened.get(task.id)).toEqual(task);
    expect(reopened.list()).toEqual([task]);
    database.close();
  });

  it("rejects duplicate task ids and never returns another task for a lookup", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createApplicationTaskRepository(database);
    const input = {
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      name: "示例投递",
      applicationUrl: "https://jobs.example.test/apply"
    };

    repository.create(input);
    expect(() => repository.create(input)).toThrow();
    expect(repository.get("bf92e60f-b559-4203-b085-625669dce70c")).toBeUndefined();
    database.close();
  });

  it("persists field coverage with a checkpoint", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";
    const checkpoints = createCheckpointRepository(database);
    checkpoints.save({
      taskId,
      state: "observing",
      url: "https://example.com/application",
      stage: "application_form",
      snapshotId: "snapshot-coverage",
      fieldIds: ["field-school"],
      questions: [],
      fieldCoverage: {
        total: 1, ready: 1, review: 0, missing: 0, unsupported: 0, filled: 0, failed: 0,
        fields: [{
          fieldId: "field-school", label: "毕业院校", semantic: "education[0].institution",
          status: "ready", source: "exact", confidence: 1, reason: "精确路径匹配", evidence: []
        }]
      }
    });

    expect(checkpoints.latest(taskId)?.fieldCoverage?.fields[0]).toMatchObject({
      fieldId: "field-school", status: "ready"
    });
    database.close();
  });

  it("deletes task checkpoints and events together with failed task metadata", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createApplicationTaskRepository(database);
    const task = repository.create({
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      name: "示例投递",
      applicationUrl: "https://jobs.example.test/apply"
    });
    createTaskEventBus(database).emit(task.id, "observing_page");
    createCheckpointRepository(database).save({
      taskId: task.id,
      state: "observing",
      url: task.applicationUrl,
      stage: "application_form",
      snapshotId: "snapshot-1",
      fieldIds: [],
      questions: []
    });
    database.prepare(`
      INSERT INTO application_answers (id, task_id, field_path, value_json, evidence_json, confidence, created_at, updated_at)
      VALUES ('answer-1', ?, 'work[0].title', '"Task title"', '[{"documentId":"user","page":1,"text":"Task title","extraction":"user"}]', 1, '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')
    `).run(task.id);
    database.prepare(`
      INSERT INTO self_evaluation_reviews (task_id, payload_json, status, created_at, updated_at)
      VALUES (?, '{}', 'needs_review', '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z')
    `).run(task.id);
    database.prepare(`
      INSERT INTO profile_facts (
        id, field_path, value_json, status, confidence, scope, task_id, evidence_json, revision, created_at, updated_at
      ) VALUES (
        'application-fact', 'application.custom', '"Task value"', 'user_confirmed', 1, 'application', ?,
        '[{"documentId":"user","page":1,"text":"Task value","extraction":"user"}]', 1,
        '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z'
      )
    `).run(task.id);

    repository.delete(task.id);

    expect(database.prepare("SELECT COUNT(*) AS count FROM application_task_events WHERE task_id = ?").get(task.id))
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM application_checkpoints WHERE task_id = ?").get(task.id))
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM application_answers WHERE task_id = ?").get(task.id))
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM self_evaluation_reviews WHERE task_id = ?").get(task.id))
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM profile_facts WHERE task_id = ?").get(task.id))
      .toEqual({ count: 0 });
    database.close();
  });

  it("derives and persists a name for legacy create callers", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);

    const first = createApplicationTaskRepository(database);
    const task = first.create({
      id: "0b4d43cc-a59b-4e85-a556-d64895051a1b",
      applicationUrl: "https://apply.careers.dji.com/campus-recruitment/dji/143359"
    });

    expect(task.name).toBe("大疆校招投递");
    const stored = database.prepare("SELECT name FROM application_tasks WHERE id = ?").get(task.id);
    expect(stored).toEqual({ name: "大疆校招投递" });

    const reopened = createApplicationTaskRepository(database);
    expect(reopened.get(task.id)).toEqual(task);
    database.close();
  });

  it("returns a suggested name for legacy tasks with no stored name", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    database.prepare(`
      INSERT INTO application_tasks (id, name, application_url, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?)
    `).run(
      "legacy-task",
      "https://apply.careers.dji.com/campus-recruitment/dji/143359",
      "2026-08-05T00:00:00.000Z",
      "2026-08-05T00:00:00.000Z"
    );

    const repository = createApplicationTaskRepository(database);
    expect(repository.get("legacy-task")?.name).toBe("大疆校招投递");
    expect(repository.list()[0]?.name).toBe("大疆校招投递");
    database.close();
  });

  it("idempotently creates the same review task for a job-match conversion", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createApplicationTaskRepository(database);
    const input = {
      id: "application-from-job",
      name: "Java Engineer",
      applicationUrl: "https://jobs.example/posting-1"
    };

    const first = repository.createFromJob(input);
    expect(repository.createFromJob(input)).toEqual(first);
    expect(repository.list()).toEqual([first]);
    expect(() => repository.createFromJob({
      ...input,
      applicationUrl: "https://jobs.example/different"
    })).toThrow("application_task_idempotency_conflict");
    database.close();
  });

  it("marks every task as Runtime-owned after the single-authority migration", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createApplicationTaskRepository(database);

    const task = repository.create({
      id: "9a92ea67-f47d-4f25-9ce7-8e2cdbd8e0cf",
      applicationUrl: "https://jobs.example.test/apply"
    });
    database.prepare(`
      INSERT INTO application_tasks (id, name, application_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      "legacy-task",
      "Legacy application",
      "https://jobs.example.test/legacy",
      "2026-08-22T00:00:00.000Z",
      "2026-08-22T00:00:00.000Z"
    );

    expect(task).toMatchObject({ orchestrator: "agent-runtime" });
    expect(repository.get("legacy-task")).toMatchObject({ orchestrator: "agent-runtime" });
    database.close();
  });

  it("rewrites an existing dual-authority task table to the Runtime-only contract", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE application_tasks (
        id TEXT PRIMARY KEY,
        name TEXT,
        application_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        profile_revision_applied INTEGER NOT NULL DEFAULT 0,
        profile_sync_status TEXT NOT NULL DEFAULT 'current',
        profile_sync_error TEXT,
        orchestrator TEXT NOT NULL DEFAULT 'xstate-v1'
          CHECK (orchestrator IN ('xstate-v1', 'langgraph-v1'))
      );
      INSERT INTO application_tasks (id, application_url, created_at, updated_at, orchestrator)
      VALUES ('legacy-runtime-migration', 'https://jobs.example.test/apply',
        '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z', 'xstate-v1');
    `);

    migrateDatabase(database);

    expect(database.prepare("SELECT orchestrator FROM application_tasks WHERE id = ?")
      .get("legacy-runtime-migration")).toEqual({ orchestrator: "agent-runtime" });
    expect(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'application_tasks'")
      .get()).toMatchObject({ sql: expect.stringContaining("orchestrator = 'agent-runtime'") });
    database.close();
  });

  it("keeps child cleanup wired after the ownership migration", async () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE application_tasks (
        id TEXT PRIMARY KEY,
        name TEXT,
        application_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        profile_revision_applied INTEGER NOT NULL DEFAULT 0,
        profile_sync_status TEXT NOT NULL DEFAULT 'current',
        profile_sync_error TEXT,
        orchestrator TEXT NOT NULL DEFAULT 'xstate-v1'
          CHECK (orchestrator IN ('xstate-v1', 'langgraph-v1'))
      );
      CREATE TABLE legacy_application_child (
        task_id TEXT NOT NULL REFERENCES application_tasks(id)
      );
    `);
    migrateDatabase(database);
    const repository = createApplicationTaskRepository(database);
    const task = repository.create({
      id: "a2c7f33e-9c11-4e3c-92c7-3a6d4ad8b0f1",
      applicationUrl: "https://jobs.example.test/legacy"
    });
    createTaskEventBus(database).emit(task.id, "observing_page");
    createCheckpointRepository(database).save({
      taskId: task.id,
      state: "observing",
      url: task.applicationUrl,
      stage: "application_form",
      snapshotId: "snapshot-legacy",
      fieldIds: [],
      questions: []
    });
    await createRuntimeApplicationStateStore(database).save({
      version: "1.0.0",
      runId: "run-legacy",
      taskId: task.id,
      applicationUrl: task.applicationUrl,
      executionEpoch: 1,
      plannedCommandIds: [],
      completedCommandIds: [],
      retryCount: 0,
      finalReviewLocked: false,
      updatedAt: "2026-09-03T00:00:00.000Z"
    });

    repository.delete(task.id);

    expect(database.prepare("SELECT COUNT(*) AS count FROM application_task_events WHERE task_id = ?").get(task.id))
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM application_checkpoints WHERE task_id = ?").get(task.id))
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_runtime_application_states WHERE run_id = ?").get("run-legacy"))
      .toEqual({ count: 0 });
    expect(database.prepare("PRAGMA foreign_key_list(legacy_application_child)").all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ table: "application_tasks" })]));
    database.close();
  });
});
