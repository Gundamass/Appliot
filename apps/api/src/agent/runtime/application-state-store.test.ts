import { describe, expect, it } from "vitest";
import { createRuntimeApplicationStateStore } from "./application-state-store.js";

function state(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.0.0",
    runId: "run-application-1",
    taskId: "task-application-1",
    applicationUrl: "https://jobs.example.test/apply",
    snapshotId: "snapshot-1",
    executionEpoch: 2,
    plannedCommandIds: ["command-1"],
    completedCommandIds: [],
    retryCount: 0,
    finalReviewLocked: false,
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides
  };
}

describe("RuntimeApplicationStateStore", () => {
  it("loads legacy 1.0.0 checkpoints as current in-memory state", async () => {
    const legacy = state();
    const persistence = {
      save() {},
      get() { return legacy as never; },
      delete() {},
      list() { return [legacy] as never[]; }
    };
    const store = createRuntimeApplicationStateStore(persistence);

    await expect(store.get("run-application-1")).resolves.toMatchObject({
      version: "1.1.0",
      runId: "run-application-1",
      taskId: "task-application-1"
    });
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ version: "1.1.0", runId: "run-application-1" })
    ]);
  });

  it("round-trips a 1.1.0 checkpoint with a safe Skill binding", async () => {
    const store = createRuntimeApplicationStateStore();
    const skillBinding = {
      skillId: "baidu-campus-application",
      version: "1.0.0",
      site: "baidu",
      pageFingerprintHash: "b".repeat(64),
      allocationId: "allocation-baidu-campus"
    };
    const skillTrace = {
      skillId: skillBinding.skillId,
      skillVersion: skillBinding.version,
      pageFingerprintHash: skillBinding.pageFingerprintHash,
      pageVariantId: "application-form",
      allocation: "champion" as const
    };

    await store.save(state({ version: "1.1.0", skillBinding, skillTrace }));

    await expect(store.get("run-application-1")).resolves.toMatchObject({
      version: "1.1.0",
      skillBinding,
      skillTrace
    });
    await expect(store.save(state({
      version: "1.1.0",
      skillBinding,
      skillTrace: { ...skillTrace, skillVersion: "2.0.0" }
    }))).rejects.toThrow("runtime_application_skill_trace_mismatch");
  });

  it("atomically keeps one Skill binding across concurrent first writers", async () => {
    const store = createRuntimeApplicationStateStore();
    await store.save(state({ version: "1.1.0" }));
    const first = {
      skillId: "baidu-application",
      version: "1.0.0",
      site: "baidu" as const,
      pageFingerprintHash: "b".repeat(64),
      allocationId: "allocation-baidu-campus"
    };
    const second = { ...first, version: "2.0.0" };

    const [left, right] = await Promise.all([
      store.bindSkill("run-application-1", "task-application-1", first),
      store.bindSkill("run-application-1", "task-application-1", second)
    ]);

    expect(left).toEqual(right);
    await expect(store.get("run-application-1")).resolves.toMatchObject({ skillBinding: left });
  });

  it("persists bounded application metadata across store instances", async () => {
    const first = createRuntimeApplicationStateStore();
    await first.save(state());

    const second = createRuntimeApplicationStateStore(first.persistence());
    const restored = await second.get("run-application-1");

    expect(restored).toMatchObject({
      runId: "run-application-1",
      taskId: "task-application-1",
      applicationUrl: "https://jobs.example.test/apply",
      snapshotId: "snapshot-1",
      executionEpoch: 2,
      plannedCommandIds: ["command-1"],
      completedCommandIds: [],
      retryCount: 0,
      finalReviewLocked: false
    });
  });

  it("round-trips pending interrupt metadata without persisting page contents", async () => {
    const store = createRuntimeApplicationStateStore();
    await store.save(state({
      pendingInterrupt: {
        id: "application-interrupt-1",
        kind: "challenge",
        reasonCode: "captcha_detected",
        questionIds: [],
        evidenceIds: ["evidence-1"],
        createdAt: "2026-09-03T00:00:00.000Z",
        runId: "run-application-1",
        taskId: "task-application-1",
        stepId: "fill_application",
        planRevision: 2,
        executionEpoch: 4,
        snapshotId: "snapshot-4",
        safetyStateRef: "application:task-application-1:epoch:4:snapshot:snapshot-4"
      }
    }));

    const restored = await store.get("run-application-1");
    expect(restored?.pendingInterrupt?.kind).toBe("challenge");
    expect(restored?.pendingInterrupt).toMatchObject({
      runId: "run-application-1",
      taskId: "task-application-1",
      stepId: "fill_application",
      planRevision: 2,
      executionEpoch: 4,
      snapshotId: "snapshot-4",
      safetyStateRef: "application:task-application-1:epoch:4:snapshot:snapshot-4"
    });
    expect(JSON.stringify(restored)).not.toContain("<form");
    expect(JSON.stringify(restored)).not.toContain("currentValue");
  });

  it("persists only redacted field coverage metadata", async () => {
    const store = createRuntimeApplicationStateStore();
    const coverage = {
      total: 1,
      ready: 0,
      review: 0,
      missing: 0,
      unsupported: 0,
      filled: 1,
      failed: 0,
      fields: [{
        fieldId: "field-email",
        label: "Email",
        semantic: "basics.email",
        status: "filled" as const,
        source: "exact" as const,
        confidence: 1,
        reason: "页面回读确认填写成功",
        evidenceRefs: ["evidence_" + "a".repeat(64)]
      }]
    };

    await store.save(state({ fieldCoverage: coverage }));

    await expect(store.get("run-application-1")).resolves.toMatchObject({ fieldCoverage: coverage });
    expect(JSON.stringify(await store.get("run-application-1"))).not.toContain("candidate@example.com");
  });

  it("rejects unknown or sensitive state before persistence", async () => {
    const store = createRuntimeApplicationStateStore();

    await expect(store.save(state({ dom: "<html>" }))).rejects.toThrow(
      "runtime_application_state_unknown_field"
    );
    await expect(store.save(state({
      pendingInterrupt: {
        id: "application-interrupt-1",
        kind: "challenge",
        reasonCode: "captcha_detected",
        questionIds: [],
        evidenceIds: [],
        createdAt: "2026-09-03T00:00:00.000Z",
        pageHtml: "<form>secret</form>"
      }
    }))).rejects.toThrow("runtime_application_state_unknown_field");
    expect(await store.get("run-application-1")).toBeUndefined();
  });
});
