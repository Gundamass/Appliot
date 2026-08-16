import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createCheckpointRepository } from "./checkpoint-repository.js";
import { createTaskEventBus } from "./task-events.js";
import { createApplicationTaskRepository } from "./application-task-repository.js";

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
});
