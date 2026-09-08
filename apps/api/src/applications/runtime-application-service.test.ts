import { describe, expect, it, vi } from "vitest";
import type { AgentRunResult, RuntimeSnapshot } from "@resume/contracts";
import { createRuntimeApplicationStateStore } from "../agent/runtime/application-state-store.js";
import { createRuntimeApplicationService } from "./runtime-application-service.js";

const task = {
  id: "task-1",
  name: "Application",
  applicationUrl: "https://jobs.example.test/apply",
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
  orchestrator: "agent-runtime" as const,
  profileRevisionApplied: 0,
  profileSyncStatus: "current" as const
};

const interrupt = {
  interruptId: "interrupt-1",
  reason: "captcha" as const,
  summary: "captcha_detected",
  evidenceRefs: [],
  proposedAction: { kind: "application_review" as const },
  expiresAt: "2026-09-03T01:00:00.000Z"
};

function repository() {
  return {
    create: vi.fn(() => task),
    createFromJob: vi.fn(() => task),
    get: vi.fn((id: string) => id === task.id ? task : undefined),
    list: vi.fn(() => [task]),
    delete: vi.fn(),
    markProfileSyncPending: vi.fn(),
    markProfileSyncFailed: vi.fn(),
    markProfileSyncSucceeded: vi.fn()
  };
}

describe("Runtime-backed ApplicationService", () => {
  it("starts and resumes application runs through Agent Runtime only", async () => {
    const runs = new Map<string, RuntimeSnapshot>();
    const stateStore = createRuntimeApplicationStateStore();
    const runtime = {
      start: vi.fn(async (): Promise<AgentRunResult> => ({
        runId: "run-1",
        status: "interrupted",
        pendingInterrupt: interrupt
      })),
      resume: vi.fn(async (): Promise<AgentRunResult> => ({
        runId: "run-1",
        status: "completed"
      })),
      recover: vi.fn(),
      cancel: vi.fn(async (): Promise<AgentRunResult> => ({ runId: "run-1", status: "cancelled" })),
      inspect: vi.fn(async (): Promise<RuntimeSnapshot> => runs.get("run-1")!)
    };
    const browser = { open: vi.fn(async () => undefined), releaseTask: vi.fn(async () => undefined) };
    const taskRepository = repository();
    const service = createRuntimeApplicationService({
      taskRepository,
      runtime,
      browser,
      stateStore,
      profileRevision: () => 4
    });

    service.start({ taskId: task.id, applicationUrl: task.applicationUrl });
    await service.openBrowser(task.id);
    await service.runUntilPause(task.id);

    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      goal: expect.stringContaining(task.applicationUrl),
      requestedBy: "application-service",
      metadata: expect.objectContaining({ applicationTaskId: task.id })
    }));
    expect(service.state(task.id).value).toBe("awaiting_challenge");

    await service.resumeAfterChallenge(task.id);
    expect(runtime.resume).toHaveBeenCalledWith("run-1", expect.objectContaining({
      interruptId: interrupt.interruptId,
      action: "confirm"
    }));
    expect(service.state(task.id).value).toBe("review_locked");
    await expect(stateStore.get("run-1")).resolves.toMatchObject({
      finalReviewLocked: true
    });
    await expect(stateStore.get("run-1")).resolves.not.toHaveProperty("pendingInterrupt");
  });

  it("registers a missing Runtime-owned task when the service is started directly", () => {
    const createdTask = { ...task, id: "task-created", applicationUrl: "https://jobs.example.test/created" };
    let storedTask: typeof createdTask | undefined;
    const taskRepository = {
      ...repository(),
      create: vi.fn(() => {
        storedTask = createdTask;
        return createdTask;
      }),
      get: vi.fn((id: string) => id === createdTask.id ? storedTask : undefined)
    };
    const service = createRuntimeApplicationService({
      taskRepository,
      runtime: { start: vi.fn(), resume: vi.fn(), recover: vi.fn(), cancel: vi.fn(), inspect: vi.fn() },
      browser: { open: vi.fn(async () => undefined) },
      profileRevision: () => 0
    });

    service.start({ taskId: createdTask.id, applicationUrl: createdTask.applicationUrl });

    expect(taskRepository.create).toHaveBeenCalledWith({
      id: createdTask.id,
      applicationUrl: createdTask.applicationUrl
    });
    expect(service.state(createdTask.id).value).toBe("observing");
  });

  it("reconstructs a pending application state after creating a fresh service", async () => {
    const stateStore = createRuntimeApplicationStateStore();
    await stateStore.save({
      version: "1.0.0",
      runId: "run-restart",
      taskId: task.id,
      applicationUrl: task.applicationUrl,
      executionEpoch: 3,
      plannedCommandIds: [],
      completedCommandIds: [],
      retryCount: 0,
      finalReviewLocked: false,
      pendingInterrupt: {
        id: "application-interrupt",
        kind: "login",
        reasonCode: "login_required",
        questionIds: [],
        evidenceIds: [],
        createdAt: "2026-09-03T00:00:00.000Z"
      },
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const service = createRuntimeApplicationService({
      taskRepository: repository(),
      runtime: {
        start: vi.fn(), resume: vi.fn(), recover: vi.fn(), cancel: vi.fn(), inspect: vi.fn()
      },
      browser: { open: vi.fn(async () => undefined) },
      stateStore,
      profileRevision: () => 0
    });

    expect(service.state(task.id).value).toBe("awaiting_login");
  });

  it("retains the pinned Skill binding while updating a resumed task", async () => {
    const stateStore = createRuntimeApplicationStateStore();
    const skillBinding = {
      skillId: "baidu-application",
      version: "1.0.0",
      site: "baidu" as const,
      pageFingerprintHash: "b".repeat(64),
      allocationId: "allocation-baidu-campus"
    };
    await stateStore.save({
      version: "1.1.0",
      runId: "run-bound",
      taskId: task.id,
      applicationUrl: task.applicationUrl,
      executionEpoch: 3,
      plannedCommandIds: [],
      completedCommandIds: [],
      retryCount: 0,
      finalReviewLocked: false,
      skillBinding,
      pendingInterrupt: {
        id: "application-interrupt",
        kind: "login",
        reasonCode: "login_required",
        questionIds: [],
        evidenceIds: [],
        createdAt: "2026-09-03T00:00:00.000Z"
      },
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const service = createRuntimeApplicationService({
      taskRepository: repository(),
      runtime: {
        start: vi.fn(),
        resume: vi.fn(async (): Promise<AgentRunResult> => ({ runId: "run-bound", status: "completed" })),
        recover: vi.fn(),
        cancel: vi.fn(),
        inspect: vi.fn(async (): Promise<RuntimeSnapshot> => ({
          runId: "run-bound",
          status: "interrupted",
          checkpoint: {
            version: "1.1.0",
            runId: "run-bound",
            executionEpoch: 3,
            status: "interrupted",
            memoryRefs: [],
            evidenceRefs: [],
            completedActionIds: [],
            budget: { steps: 0, toolCalls: 0, retries: 0, replans: 0, tokens: 0, elapsedMs: 0 },
            stateHash: "a".repeat(64),
            createdAt: "2026-09-03T00:00:00.000Z",
            pendingInterrupt: interrupt
          },
          updatedAt: "2026-09-03T00:00:00.000Z"
        }))
      },
      browser: { open: vi.fn(async () => undefined) },
      stateStore,
      profileRevision: () => 0
    });

    expect(service.state(task.id).value).toBe("awaiting_login");
    await service.resume(task.id);

    await expect(stateStore.get("run-bound")).resolves.toMatchObject({
      version: "1.1.0",
      skillBinding,
      finalReviewLocked: true
    });
  });

  it("exposes redacted field coverage after a service restart", async () => {
    const stateStore = createRuntimeApplicationStateStore();
    await stateStore.save({
      version: "1.0.0",
      runId: "run-coverage",
      taskId: task.id,
      applicationUrl: task.applicationUrl,
      executionEpoch: 1,
      plannedCommandIds: [],
      completedCommandIds: [],
      retryCount: 0,
      finalReviewLocked: false,
      fieldCoverage: {
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
          status: "filled",
          source: "exact",
          confidence: 1,
          reason: "页面回读确认填写成功",
          evidenceRefs: []
        }]
      },
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const service = createRuntimeApplicationService({
      taskRepository: repository(),
      runtime: { start: vi.fn(), resume: vi.fn(), recover: vi.fn(), cancel: vi.fn(), inspect: vi.fn() },
      browser: { open: vi.fn(async () => undefined) },
      stateStore,
      profileRevision: () => 0
    });

    expect(service.fieldCoverage(task.id)).toMatchObject({
      total: 1,
      filled: 1,
      fields: [expect.objectContaining({ fieldId: "field-email", status: "filled", evidence: [] })]
    });
  });
});
