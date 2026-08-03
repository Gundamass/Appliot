import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createCheckpointRepository } from "./checkpoint-repository.js";
import { createTaskEventBus } from "./task-events.js";
import { createApplicationTaskRepository } from "./application-task-repository.js";

describe("application task repository", () => {
  it("persists task metadata across repository instances", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);

    const first = createApplicationTaskRepository(database);
    const task = first.create({
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
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
      applicationUrl: "https://jobs.example.test/apply"
    };

    repository.create(input);
    expect(() => repository.create(input)).toThrow();
    expect(repository.get("bf92e60f-b559-4203-b085-625669dce70c")).toBeUndefined();
    database.close();
  });

  it("deletes task checkpoints and events together with failed task metadata", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createApplicationTaskRepository(database);
    const task = repository.create({
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
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
});
