import Database from "better-sqlite3";
import type { FormSnapshot } from "@resume/contracts";
import { describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createApplicationService } from "./application-service.js";
import { createCheckpointRepository } from "./checkpoint-repository.js";

const baseSnapshot: FormSnapshot = {
  id: "snapshot-application",
  taskId: "task-challenge",
  url: "https://jobs.example.test/apply",
  title: "Application",
  stage: "application_form",
  frameRef: { documentId: "document-challenge", kind: "main" },
  mutationEpoch: 1,
  boundaries: [],
  fields: [],
  actions: [],
  errors: []
};

const challengeSnapshot: FormSnapshot = {
  ...baseSnapshot,
  id: "snapshot-challenge",
  challenge: {
    kind: "captcha",
    detectedAt: "2026-08-15T00:00:00.000Z",
    reasonCode: "moka_captcha_accessible_name"
  }
};

describe("challenge coordinator", () => {
  it("invalidates execution before persisting the challenge pause and resumes from a fresh observation", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const order: string[] = [];
    const observe = vi.fn()
      .mockImplementationOnce(async () => {
        order.push("observe:challenge");
        return challengeSnapshot;
      })
      .mockImplementationOnce(async () => {
        order.push("observe:fresh");
        return { ...baseSnapshot, id: "snapshot-review", stage: "review" as const };
      });
    const invalidateExecution = vi.fn(async () => { order.push("invalidate"); });
    const repository = {
      ...checkpoints,
      save: vi.fn((checkpoint: Parameters<typeof checkpoints.save>[0]) => {
        order.push(`persist:${checkpoint.state}`);
        return checkpoints.save(checkpoint);
      })
    };
    const service = createApplicationService({
      checkpoints: repository,
      browser: { observe, execute: vi.fn(), invalidateExecution },
      resolveField: async () => ({ status: "deferred" }),
      approve: () => "unused"
    });
    service.start({ taskId: baseSnapshot.taskId, applicationUrl: baseSnapshot.url });

    await service.runUntilPause(baseSnapshot.taskId);

    expect(order).toEqual([
      "observe:challenge",
      "invalidate",
      "persist:awaiting_challenge"
    ]);
    expect(service.state(baseSnapshot.taskId).value).toBe("awaiting_challenge");
    expect(service.state(baseSnapshot.taskId).context.challenge).toEqual(challengeSnapshot.challenge);
    expect(checkpoints.latest(baseSnapshot.taskId)).toMatchObject({
      state: "awaiting_challenge",
      snapshot: { challenge: challengeSnapshot.challenge }
    });
    const previousObserveCalls = observe.mock.calls.length;

    await service.resumeAfterChallenge(baseSnapshot.taskId);

    expect(observe).toHaveBeenCalledTimes(previousObserveCalls + 1);
    expect(invalidateExecution).toHaveBeenCalledTimes(2);
    expect(service.state(baseSnapshot.taskId).value).toBe("review_locked");
    expect(service.state(baseSnapshot.taskId).context.challenge).toBeUndefined();
    database.close();
  });

  it("restores a persisted challenge pause without observing until explicit resume", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    checkpoints.save({
      taskId: baseSnapshot.taskId,
      state: "awaiting_challenge",
      url: challengeSnapshot.url,
      stage: challengeSnapshot.stage,
      snapshotId: challengeSnapshot.id,
      fieldIds: [],
      questions: [],
      snapshot: challengeSnapshot
    });
    const observe = vi.fn(async () => ({ ...baseSnapshot, id: "snapshot-review", stage: "review" as const }));
    const service = createApplicationService({
      checkpoints,
      browser: { observe, execute: vi.fn(), invalidateExecution: vi.fn() },
      resolveField: async () => ({ status: "deferred" }),
      approve: () => "unused"
    });

    expect(service.state(baseSnapshot.taskId).value).toBe("awaiting_challenge");
    await service.runUntilPause(baseSnapshot.taskId);
    expect(observe).not.toHaveBeenCalled();

    await service.resumeAfterChallenge(baseSnapshot.taskId);
    expect(observe).toHaveBeenCalledOnce();
    expect(service.state(baseSnapshot.taskId).value).toBe("review_locked");
    database.close();
  });

  it("fails closed when an awaiting-challenge checkpoint has no valid diagnostic", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    checkpoints.save({
      taskId: baseSnapshot.taskId,
      state: "awaiting_challenge",
      url: baseSnapshot.url,
      stage: baseSnapshot.stage,
      snapshotId: baseSnapshot.id,
      fieldIds: [],
      questions: [],
      snapshot: baseSnapshot
    });
    const service = createApplicationService({
      checkpoints,
      browser: { observe: vi.fn(), execute: vi.fn() },
      resolveField: async () => ({ status: "deferred" }),
      approve: () => "unused"
    });

    expect(() => service.state(baseSnapshot.taskId)).toThrow("challenge_checkpoint_invalid");
    database.close();
  });
});
