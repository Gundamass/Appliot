import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createCheckpointRepository } from "./checkpoint-repository.js";
import { createTaskEventBus } from "./task-events.js";
import { createApplicationTaskRepository } from "./application-task-repository.js";
import { createRuntimeApplicationStateStore } from "../agent/runtime/application-state-store.js";

describe("application task repository", () => {
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
