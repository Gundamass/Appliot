import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createCheckpointRepository } from "./checkpoint-repository.js";
import { createTaskEventBus } from "./task-events.js";
import {
  createApplicationProgressCoordinator,
  type ApplicationProgressCoordinatorOptions
} from "./application-progress.js";

const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";
type ProgressEventInput = Parameters<NonNullable<ApplicationProgressCoordinatorOptions["emit"]>>[1];

describe("application progress coordinator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("disposes an active task without leaving timers or recovery state behind", async () => {
    const events: string[] = [];
    const coordinator = createApplicationProgressCoordinator({
      emit: (_taskId, event) => events.push(event.type)
    });
    const pending = coordinator.runOperation({
      taskId, kind: "fill", fieldId: "field-phone", displayCategory: "联系方式",
      current: 1, total: 1, timeoutMs: 15_000
    }, () => new Promise<never>(() => undefined));
    const rejection = expect(pending).rejects.toThrow("operation_cancelled");

    coordinator.dispose(taskId);

    await rejection;
    await vi.advanceTimersByTimeAsync(15_001);
    expect(coordinator.snapshot(taskId)).toEqual({
      status: "idle", busy: false, generation: 0, retryCount: 0, recovery: []
    });
    expect(events).toEqual(["operation_started"]);
  });

  it("超时后进入可恢复暂停并始终释放忙碌状态", async () => {
    const events: string[] = [];
    const coordinator = createApplicationProgressCoordinator({
      now: () => Date.now(),
      emit: (_taskId, event) => events.push(event.type)
    });

    const pending = coordinator.runOperation({
      taskId,
      kind: "fill",
      fieldId: "field-phone",
      displayCategory: "联系方式",
      current: 1,
      total: 2,
      timeoutMs: 15_000
    }, () => new Promise<never>(() => undefined));

    const rejection = expect(pending).rejects.toThrow("operation_timeout");
    await vi.advanceTimersByTimeAsync(15_001);
    await rejection;
    expect(coordinator.snapshot(taskId)).toMatchObject({
      status: "paused",
      busy: false,
      stalledFieldId: "field-phone",
      recovery: ["retry_current", "manual_done", "cancel"]
    });
    expect(events).toEqual(["operation_started", "operation_failed", "task_paused"]);
  });

  it("同一任务拒绝并发操作，旧代际清理不会覆盖新操作", async () => {
    const coordinator = createApplicationProgressCoordinator({ now: () => Date.now() });
    const first = coordinator.startOperation({
      taskId, kind: "fill", fieldId: "field-phone", displayCategory: "联系方式",
      current: 1, total: 2, timeoutMs: 15_000
    });

    expect(() => coordinator.startOperation({
      taskId, kind: "fill", fieldId: "field-email", displayCategory: "联系方式",
      current: 2, total: 2, timeoutMs: 15_000
    })).toThrow("operation_already_active");

    coordinator.completeOperation(taskId, first.generation);
    const second = coordinator.startOperation({
      taskId, kind: "fill", fieldId: "field-email", displayCategory: "联系方式",
      current: 2, total: 2, timeoutMs: 15_000
    });
    coordinator.completeOperation(taskId, first.generation);

    expect(coordinator.snapshot(taskId)).toMatchObject({
      status: "running",
      busy: true,
      active: { fieldId: "field-email" }
    });
    coordinator.completeOperation(taskId, second.generation);
  });

  it("用户活动会取消待执行自动操作且暂停期间不能开始后续字段", async () => {
    const coordinator = createApplicationProgressCoordinator({ now: () => Date.now() });
    const pending = coordinator.runOperation({
      taskId, kind: "select", fieldId: "field-city", displayCategory: "求职信息",
      current: 1, total: 2, timeoutMs: 15_000
    }, () => new Promise<never>(() => undefined));

    coordinator.handleUserActivity(taskId, "field-city");

    await expect(pending).rejects.toThrow("operation_cancelled_by_user");
    expect(coordinator.snapshot(taskId)).toMatchObject({ status: "paused", busy: false });
    expect(() => coordinator.startOperation({
      taskId, kind: "fill", fieldId: "field-next", displayCategory: "当前字段",
      current: 2, total: 2, timeoutMs: 15_000
    })).toThrow("task_paused");
  });

  it("用户操作其他控件时也会取消当前待执行动作", async () => {
    const coordinator = createApplicationProgressCoordinator({ now: () => Date.now() });
    const pending = coordinator.runOperation({
      taskId, kind: "fill", fieldId: "field-phone", displayCategory: "联系方式",
      current: 1, total: 2, timeoutMs: 15_000
    }, () => new Promise<never>(() => undefined));
    const rejection = expect(pending).rejects.toThrow("operation_cancelled_by_user");

    coordinator.handleUserActivity(taskId, "field-job-selector");

    await rejection;
    expect(coordinator.snapshot(taskId)).toMatchObject({ status: "paused", busy: false });
  });

  it("显式取消会终止当前操作且不提供恢复命令", async () => {
    const coordinator = createApplicationProgressCoordinator({ now: () => Date.now() });
    const pending = coordinator.runOperation({
      taskId, kind: "fill", fieldId: "field-phone", displayCategory: "联系方式",
      current: 1, total: 1, timeoutMs: 15_000
    }, () => new Promise<never>(() => undefined));

    coordinator.cancel(taskId);

    await expect(pending).rejects.toThrow("operation_cancelled");
    expect(coordinator.snapshot(taskId)).toMatchObject({
      status: "idle", busy: false, recovery: []
    });
  });

  it.each(["upload", "navigate"] as const)("%s 超时后直接暂停且不自动重试", async (kind) => {
    const coordinator = createApplicationProgressCoordinator({ now: () => Date.now() });
    const operation = vi.fn(() => new Promise<never>(() => undefined));
    const pending = coordinator.runWithPolicy({
      taskId, kind, fieldId: "field-file", displayCategory: "附件",
      current: 1, total: 1, timeoutMs: 100
    }, operation);

    const rejection = expect(pending).rejects.toThrow("operation_timeout");
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    expect(operation).toHaveBeenCalledOnce();
    expect(coordinator.snapshot(taskId).status).toBe("paused");
  });

  it("普通安全编辑超时后最多自动重试一次", async () => {
    const coordinator = createApplicationProgressCoordinator({ now: () => Date.now() });
    const operation = vi.fn(() => new Promise<never>(() => undefined));
    const pending = coordinator.runWithPolicy({
      taskId, kind: "fill", fieldId: "field-phone", displayCategory: "联系方式",
      current: 1, total: 1, timeoutMs: 100
    }, operation, { canRetry: async () => true });

    const rejection = expect(pending).rejects.toThrow("operation_timeout");
    await vi.advanceTimersByTimeAsync(201);
    await rejection;
    expect(operation).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot(taskId)).toMatchObject({ status: "paused", busy: false, retryCount: 1 });
  });

  it("安全重试的第一次失败不应对外发布暂停", async () => {
    const persisted: import("./application-progress.js").ApplicationProgressSnapshot[] = [];
    const coordinator = createApplicationProgressCoordinator({
      persist: (_taskId, snapshot) => persisted.push(snapshot)
    });
    const operation = vi.fn(() => new Promise<never>(() => undefined));
    const pending = coordinator.runWithPolicy({
      taskId, kind: "fill", fieldId: "field-phone", displayCategory: "联系方式",
      current: 1, total: 1, timeoutMs: 100
    }, operation, { canRetry: () => true });

    await vi.advanceTimersByTimeAsync(101);

    expect(operation).toHaveBeenCalledTimes(2);
    expect(persisted.some((snapshot) => snapshot.status === "paused")).toBe(false);
    coordinator.dispose(taskId);
    await expect(pending).rejects.toThrow("operation_cancelled");
  });

  it("调用方接管失败时不会把不可重试的编辑升级为用户暂停", async () => {
    const events: ProgressEventInput[] = [];
    const coordinator = createApplicationProgressCoordinator({
      emit: (_taskId, event) => events.push(event)
    });

    await expect(coordinator.runWithPolicy({
      taskId, kind: "select", fieldId: "field-award", displayCategory: "当前字段",
      current: 1, total: 1, timeoutMs: 100
    }, async () => {
      throw new Error("custom_option_ambiguous");
    }, {
      canRetry: async () => false,
      finalFailureMode: "defer"
    })).rejects.toThrow("custom_option_ambiguous");

    expect(coordinator.snapshot(taskId)).toMatchObject({
      status: "idle",
      busy: false,
      recovery: []
    });
    expect(coordinator.snapshot(taskId)).not.toHaveProperty("stalledFieldId");
    expect(events.map((event) => event.type)).toEqual(["operation_started"]);
  });

  it("每个新字段分别拥有一次安全重试机会", async () => {
    const coordinator = createApplicationProgressCoordinator({ now: () => Date.now() });
    const firstOperation = vi.fn()
      .mockRejectedValueOnce(new Error("第一次失败"))
      .mockResolvedValueOnce("已完成");
    await expect(coordinator.runWithPolicy({
      taskId, kind: "fill", fieldId: "field-phone", displayCategory: "联系方式",
      current: 1, total: 2, timeoutMs: 100
    }, firstOperation, { canRetry: async () => true })).resolves.toBe("已完成");

    const secondOperation = vi.fn()
      .mockRejectedValueOnce(new Error("第一次失败"))
      .mockResolvedValueOnce("已完成");
    await expect(coordinator.runWithPolicy({
      taskId, kind: "fill", fieldId: "field-email", displayCategory: "联系方式",
      current: 2, total: 2, timeoutMs: 100
    }, secondOperation, { canRetry: async () => true })).resolves.toBe("已完成");

    expect(firstOperation).toHaveBeenCalledTimes(2);
    expect(secondOperation).toHaveBeenCalledTimes(2);
  });

  it("同一语义字段在重渲染和恢复后总共最多执行两次", async () => {
    const retryKey = "field-operation:education-major";
    const firstCoordinator = createApplicationProgressCoordinator();
    const attempts: number[] = [];

    await expect(firstCoordinator.runWithPolicy({
      taskId, kind: "select", fieldId: "field-major-before", retryKey, displayCategory: "教育经历",
      current: 1, total: 1, timeoutMs: 100
    }, async (attempt) => {
      attempts.push(attempt);
      throw new Error("没有匹配项");
    }, { canRetry: () => false, finalFailureMode: "defer" })).rejects.toThrow("没有匹配项");

    await expect(firstCoordinator.runWithPolicy({
      taskId, kind: "select", fieldId: "field-major-after", retryKey, displayCategory: "教育经历",
      current: 1, total: 1, timeoutMs: 100
    }, async (attempt) => {
      attempts.push(attempt);
      throw new Error("没有匹配项");
    }, { canRetry: () => false, finalFailureMode: "defer" })).rejects.toThrow("没有匹配项");

    const persisted = firstCoordinator.snapshot(taskId);
    expect(persisted.attemptCountsByKey).toEqual({ [retryKey]: 2 });

    const restoredCoordinator = createApplicationProgressCoordinator();
    restoredCoordinator.restore(taskId, persisted);
    const forbiddenThirdOperation = vi.fn(async (_attempt: 1 | 2) => "不应执行");
    await expect(restoredCoordinator.runWithPolicy({
      taskId, kind: "select", fieldId: "field-major-third", retryKey, displayCategory: "教育经历",
      current: 1, total: 1, timeoutMs: 100
    }, forbiddenThirdOperation, { finalFailureMode: "defer" }))
      .rejects.toThrow("automatic_attempt_limit_reached");

    expect(attempts).toEqual([1, 2]);
    expect(forbiddenThirdOperation).not.toHaveBeenCalled();
  });

  it("在浏览器操作开始前持久化当前尝试次数", async () => {
    const retryKey = "field-operation:education-school";
    const persisted: import("./application-progress.js").ApplicationProgressSnapshot[] = [];
    const coordinator = createApplicationProgressCoordinator({
      persist: (_taskId, snapshot) => persisted.push(snapshot)
    });

    await expect(coordinator.runWithPolicy({
      taskId, kind: "select", fieldId: "field-school", retryKey, displayCategory: "教育经历",
      current: 1, total: 1, timeoutMs: 100
    }, async (attempt) => {
      expect(attempt).toBe(1);
      expect(persisted.at(-1)?.attemptCountsByKey).toEqual({ [retryKey]: 1 });
      return "已选择";
    })).resolves.toBe("已选择");
  });

  it("从旧版字段重试检查点恢复已消耗的两次尝试", async () => {
    const fieldId = "field-major";
    const coordinator = createApplicationProgressCoordinator();
    coordinator.restore(taskId, {
      status: "idle",
      busy: false,
      generation: 2,
      retryCount: 1,
      retryCountsByField: { [fieldId]: 1 },
      recovery: []
    });
    const operation = vi.fn(async (_attempt: 1 | 2) => "不应执行");

    await expect(coordinator.runWithPolicy({
      taskId, kind: "select", fieldId, displayCategory: "教育经历",
      current: 1, total: 1, timeoutMs: 100
    }, operation)).rejects.toThrow("automatic_attempt_limit_reached");
    expect(operation).not.toHaveBeenCalled();
  });

  it("持久化进度事件并在事件总线重启后重放", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const first = createTaskEventBus(database);
    const event = first.emitProgress(taskId, {
      type: "operation_started",
      progress: {
        current: 1, total: 2, phase: "filling", fieldId: "field-phone", displayCategory: "联系方式"
      },
      operation: { kind: "fill", status: "running", elapsedMs: 0, timeoutMs: 15_000 }
    });

    expect(createTaskEventBus(database).replayAll(taskId).events).toContainEqual(event);
    database.close();
  });

  it("保留显式填写阶段并为校验操作提供动态校验默认阶段", () => {
    const events: ProgressEventInput[] = [];
    const coordinator = createApplicationProgressCoordinator({
      emit: (_taskId, event) => events.push(event)
    });

    const semantic = coordinator.startOperation({
      taskId,
      kind: "fill",
      displayPhase: "semantic_fill",
      fieldId: "field-training-mode",
      displayCategory: "教育经历",
      current: 2,
      total: 5,
      timeoutMs: 15_000
    });
    coordinator.completeOperation(taskId, semantic.generation);
    coordinator.startOperation({
      taskId,
      kind: "validate",
      fieldId: "page",
      displayCategory: "页面状态",
      current: 1,
      total: 1,
      timeoutMs: 10_000
    });

    const started = events.filter((event): event is Extract<ProgressEventInput, { type: "operation_started" }> =>
      event.type === "operation_started");
    expect(started.map((event) => event.progress.displayPhase)).toEqual([
      "semantic_fill",
      "dynamic_validation"
    ]);
  });

  it("持久化并发布真实执行阶段、当前动作和覆盖统计", () => {
    const events: ProgressEventInput[] = [];
    const persisted: import("./application-progress.js").ApplicationProgressSnapshot[] = [];
    const coordinator = createApplicationProgressCoordinator({
      emit: (_taskId, event) => events.push(event),
      persist: (_taskId, snapshot) => persisted.push(snapshot)
    });

    coordinator.setPhase(taskId, "deterministic_fill", "running");
    coordinator.setCurrentAction(taskId, {
      action: "正在选择：本科专业",
      fieldId: "field-major",
      attempt: 1,
      maxAttempts: 2
    });
    coordinator.setCounts(taskId, { exact: 5, semantic: 1, user: 2, missing: 1, failed: 0 });

    expect(coordinator.snapshot(taskId).executionProgress).toMatchObject({
      currentPhase: "deterministic_fill",
      phases: expect.arrayContaining([
        { phase: "deterministic_fill", status: "running" }
      ]),
      current: {
        action: "正在选择：本科专业",
        fieldId: "field-major",
        attempt: 1,
        maxAttempts: 2
      },
      counts: { exact: 5, semantic: 1, user: 2, missing: 1, failed: 0 }
    });
    expect(events.filter((event) => event.type === "execution_progress_changed")).toHaveLength(3);
    expect(persisted.at(-1)?.executionProgress).toEqual(coordinator.snapshot(taskId).executionProgress);
  });

  it("恢复显式进度并为旧检查点推导兼容阶段", () => {
    const current = createApplicationProgressCoordinator();
    current.setPhase(taskId, "semantic_fill", "running");
    current.setCurrentAction(taskId, { action: "正在补全：赛事名称", maxAttempts: 2 });
    const persisted = current.snapshot(taskId);

    const restored = createApplicationProgressCoordinator();
    restored.restore(taskId, persisted);
    expect(restored.snapshot(taskId).executionProgress).toEqual(persisted.executionProgress);

    const legacy = createApplicationProgressCoordinator();
    legacy.restore("legacy-task", {
      status: "idle",
      busy: false,
      generation: 1,
      retryCount: 0,
      lastResult: {
        current: 1,
        total: 1,
        phase: "validating",
        fieldId: "page",
        displayCategory: "页面状态",
        operation: { kind: "validate", status: "succeeded", elapsedMs: 10, timeoutMs: 1_000 }
      },
      recovery: []
    });
    expect(legacy.snapshot("legacy-task").executionProgress).toMatchObject({
      currentPhase: "readback_validation",
      current: { action: "正在校验页面填写结果", maxAttempts: 2 }
    });
  });

  it("持久化可恢复进度并在检查点仓库重启后恢复", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const first = createCheckpointRepository(database);
    const progress: import("./application-progress.js").ApplicationProgressSnapshot = {
      status: "paused" as const,
      busy: false,
      generation: 2,
      retryCount: 1,
      attemptCountsByKey: {
        "field-operation:education-major": 2,
        "field-operation:project-start-year": 1
      },
      stalledFieldId: "field-phone",
      recovery: ["retry_current", "manual_done", "cancel"]
    };

    first.saveProgress(taskId, progress);

    expect(createCheckpointRepository(database).latestProgress(taskId)).toEqual(progress);
    database.close();
  });
});
