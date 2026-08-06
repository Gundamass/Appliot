import Database from "better-sqlite3";
import { ApplicationTaskEventSchema, type ExecutableCommand, type FormField, type FormSnapshot, type WorkerActivity, type WorkerResponse } from "@resume/contracts";
import { createActor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { applicationMachine, sendApplicationEvent } from "./application-machine.js";
import { createApplicationService } from "./application-service.js";
import { createCheckpointRepository } from "./checkpoint-repository.js";
import { createTaskEventBus, type TaskEventBus } from "./task-events.js";
import { createApplicationTaskRepository } from "./application-task-repository.js";

type ProgressEventPayload = Parameters<TaskEventBus["emitProgress"]>[1];

function captureProgressEvents(progressEvents: ProgressEventPayload[]): Pick<TaskEventBus, "emit" | "emitProgress"> {
  return {
    emit: (_taskId, state) => ({
      type: "state_changed" as const,
      taskId: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      id: "0",
      state,
      createdAt: "2026-08-03T00:00:00.000Z"
    }),
    emitProgress(_taskId, event) {
      progressEvents.push(event);
      return ApplicationTaskEventSchema.parse({
        ...event,
        taskId: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
        id: "0",
        createdAt: "2026-08-03T00:00:00.000Z"
      });
    }
  };
}

function snapshot(stage: FormSnapshot["stage"], options: { action?: boolean } = {}): FormSnapshot {
  return {
    id: `snapshot-${stage}`,
    taskId: "task-1",
    url: `https://jobs.example.test/${stage}`,
    title: stage === "review" ? "确认申请" : "填写申请",
    stage,
    fields: [],
    actions: options.action ? [{
      id: "action-next",
      text: "下一步",
      class: "intermediate_navigation"
    }] : stage === "review" ? [{
      id: "action-submit",
      text: "提交申请",
      class: "terminal_submit"
    }] : [],
    errors: []
  };
}

describe("application machine", () => {
  it("allows only explicit page transitions and makes review_locked terminal", () => {
    const actor = createActor(applicationMachine, {
      input: { taskId: "task-1", applicationUrl: "https://jobs.example.test/apply" }
    }).start();

    sendApplicationEvent(actor, { type: "START" });
    expect(actor.getSnapshot().value).toBe("observing");
    sendApplicationEvent(actor, { type: "READY_TO_FILL" });
    sendApplicationEvent(actor, { type: "PAGE_FILLED" });
    sendApplicationEvent(actor, { type: "PAGE_VALID" });
    sendApplicationEvent(actor, { type: "PAGE_NAVIGATED" });
    sendApplicationEvent(actor, { type: "REVIEW_REACHED" });
    expect(actor.getSnapshot().value).toBe("review_locked");
    expect(() => sendApplicationEvent(actor, { type: "PAGE_NAVIGATED" })).toThrow("review_locked");
    expect(() => sendApplicationEvent(actor, { type: "CANCEL" })).toThrow("review_locked");
  });

  it("allows a partially filled page to hand unresolved fields to questions", () => {
    const actor = createActor(applicationMachine, {
      input: { taskId: "task-1", applicationUrl: "https://jobs.example.test/apply" }
    }).start();

    sendApplicationEvent(actor, { type: "START" });
    sendApplicationEvent(actor, { type: "READY_TO_FILL" });
    sendApplicationEvent(actor, {
      type: "QUESTIONS_REQUIRED",
      questions: [{
        id: "field-unknown",
        fieldId: "field-unknown",
        fieldPath: "application.jobSpecific",
        label: "培养方式",
        text: "请确认培养方式",
        pageText: "培养方式",
        interpretation: "待确认字段",
        missingInformation: "缺少培养方式",
        scope: "application",
        inputType: "select",
        options: ["统招", "定向"],
        required: true
      }]
    });

    expect(actor.getSnapshot().value).toBe("needs_questions");
  });

  it("returns from a missing-profile question to observing without writing an answer", () => {
    const actor = createActor(applicationMachine, {
      input: { taskId: "task-1", applicationUrl: "https://jobs.example.test/apply" }
    }).start();

    sendApplicationEvent(actor, { type: "START" });
    sendApplicationEvent(actor, { type: "QUESTIONS_REQUIRED", questions: [{
      id: "question-city",
      fieldId: "field-city",
      text: "请补充城市",
      pageText: "期望城市",
      interpretation: "系统识别为投递偏好字段",
      missingInformation: "缺少城市",
      scope: "application",
      inputType: "text",
      options: [],
      required: true
    }] });
    sendApplicationEvent(actor, { type: "PROFILE_UPDATED" });

    expect(actor.getSnapshot().value).toBe("observing");
    expect(actor.getSnapshot().context.questions).toEqual([]);
  });

  it("fills deterministic fields before asking about semantic-only residual fields", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const progressEvents: ProgressEventPayload[] = [];
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" },
        { id: "field-training", label: "培养方式", type: "select", required: true, options: ["统招", "定向"], currentValue: "" }
      ]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-phone-filled",
      fields: [
        { ...form.fields[0]!, currentValue: "13800000000" },
        form.fields[1]!
      ]
    };
    const execute = vi.fn(async (): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: "task-1",
      snapshotId: filled.id,
      commandType: "fill",
      status: "applied",
      actualValue: "13800000000",
      snapshot: filled,
      errors: []
    }));
    const resolveField = vi.fn(async (
      _taskId: string,
      field: FormField,
      phase?: "deterministic" | "semantic"
    ) => {
      if (field.id === "field-phone") {
        return { status: "verified" as const, value: "13800000000", fieldPath: "basics.phone" };
      }
      return phase === "deterministic"
        ? { status: "deferred" as const }
        : {
            status: "needs_question" as const,
            question: "请确认培养方式",
            fieldPath: "education[0].enrollmentType"
          };
    });
    const service = createApplicationService({
      checkpoints,
      taskEvents: captureProgressEvents(progressEvents),
      browser: { observe: async () => form, execute },
      resolveField,
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      type: "fill",
      fieldId: "field-phone",
      value: "13800000000"
    }), expect.any(Number));
    expect(resolveField).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ id: "field-phone" }),
      "deterministic"
    );
    expect(resolveField).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ id: "field-training" }),
      "semantic"
    );
    expect(service.state("task-1").value).toBe("needs_questions");
    expect(service.state("task-1").context.questions).toHaveLength(1);
    expect(service.state("task-1").context.questions[0]?.fieldId).toBe("field-training");
    const started = progressEvents.filter((event) => event.type === "operation_started");
    expect(started.find((event) => event.progress.fieldId === "field-phone")?.progress.displayPhase).toBe("deterministic_fill");
    database.close();
  });

  it("automatically retries a transient safe fill after a matching page readback", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-phone-filled",
      fields: [{ ...form.fields[0]!, currentValue: "13800000000" }]
    };
    const observe = vi.fn(async () => form);
    const invalidateExecution = vi.fn(async (_taskId: string, _epoch: number) => undefined);
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("transient fill failure"))
      .mockResolvedValueOnce({
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: filled.id,
        commandType: "fill" as const,
        status: "applied" as const,
        actualValue: "13800000000",
        snapshot: filled,
        errors: []
      });
    const service = createApplicationService({
      checkpoints,
      browser: { observe, execute, invalidateExecution },
      resolveField: async () => ({ status: "verified" as const, value: "13800000000" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledTimes(2);
    const firstEpoch = execute.mock.calls[0]?.[1];
    const retryEpoch = execute.mock.calls[1]?.[1];
    const invalidationEpoch = invalidateExecution.mock.calls[0]?.[1];
    expect(firstEpoch).toEqual(expect.any(Number));
    expect(invalidationEpoch).toEqual(expect.any(Number));
    expect(retryEpoch).toEqual(expect.any(Number));
    expect(invalidationEpoch).toBeGreaterThan(firstEpoch!);
    expect(retryEpoch).toBeGreaterThan(invalidationEpoch!);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("does not retry a failed fill after the readback snapshot changes", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const changedSnapshot: FormSnapshot = { ...form, id: "snapshot-after-page-change" };
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockResolvedValueOnce(changedSnapshot);
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("transient fill failure"))
      .mockRejectedValue(new Error("unexpected retry"));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute, invalidateExecution: vi.fn(async () => undefined) },
      resolveField: async () => ({ status: "verified" as const, value: "13800000000" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.progress("task-1")).toMatchObject({
      status: "paused",
      recovery: ["retry_current", "manual_done", "cancel"]
    });
    database.close();
  });

  it("does not retry a failed fill after the readback shows the target already filled", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const readback: FormSnapshot = {
      ...form,
      fields: [{ ...form.fields[0]!, currentValue: "13800000000" }]
    };
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockResolvedValueOnce(readback);
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("transient fill failure"))
      .mockRejectedValue(new Error("unexpected retry"));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute, invalidateExecution: vi.fn(async () => undefined) },
      resolveField: async () => ({ status: "verified" as const, value: "13800000000" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.progress("task-1")).toMatchObject({
      status: "paused",
      recovery: ["retry_current", "manual_done", "cancel"]
    });
    database.close();
  });

  it.each(["blocked", "failed"] as const)("pauses on a %s browser fill and can retry only after a fresh observation", async (status) => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-phone-filled",
      fields: [{ ...form.fields[0]!, currentValue: "13800000000" }]
    };
    const observe = vi.fn(async () => form);
    const execute = vi.fn()
      .mockResolvedValueOnce({
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: form.id,
        commandType: "fill" as const,
        status,
        actualValue: "",
        snapshot: form,
        errors: ["field_not_found"]
      })
      .mockResolvedValueOnce({
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: filled.id,
        commandType: "fill" as const,
        status: "applied" as const,
        actualValue: "13800000000",
        snapshot: filled,
        errors: []
      });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField: async () => ({ status: "verified" as const, value: "13800000000" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("observing");
    expect(service.progress("task-1")).toMatchObject({
      status: "paused",
      recovery: ["retry_current", "cancel"],
      lastResult: { operation: { status: "failed" } }
    });

    await service.retryCurrent("task-1");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(service.state("task-1").value).toBe("review_locked");
    expect(service.progress("task-1")).toMatchObject({ status: "idle", recovery: [] });
    database.close();
  });

  it("does not retry a timed-out fill after the page becomes unstable", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    let releaseReadback!: (value: FormSnapshot) => void;
    const readback = new Promise<FormSnapshot>((resolve) => {
      releaseReadback = resolve;
    });
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockImplementationOnce(async () => readback);
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("transient fill failure"))
      .mockRejectedValue(new Error("unexpected retry"));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField: async () => ({ status: "verified" as const, value: "13800000000" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    const running = service.runUntilPause("task-1");

    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
    await service.handleActivity({ type: "page_unstable", taskId: "task-1", fingerprint: "unstable-page" });
    releaseReadback(form);
    await running;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.progress("task-1")).toMatchObject({
      status: "paused",
      recovery: ["retry_current", "manual_done", "cancel"]
    });
    database.close();
  });

  it("publishes deterministic and semantic field fills with distinct workbench phases", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const progressEvents: ProgressEventPayload[] = [];
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      actions: [{ id: "submit", text: "提交申请", class: "terminal_submit" }],
      fields: [
        { id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" },
        { id: "field-training", label: "培养方式", type: "select", required: true, options: ["统招", "定向"], currentValue: "" }
      ]
    };
    const phoneFilled: FormSnapshot = {
      ...form,
      id: "snapshot-phone-filled",
      fields: [{ ...form.fields[0]!, currentValue: "13800000000" }, form.fields[1]!]
    };
    const fullyFilled: FormSnapshot = {
      ...form,
      id: "snapshot-fully-filled",
      fields: [{ ...phoneFilled.fields[0]! }, { ...form.fields[1]!, currentValue: "统招" }]
    };
    const execute = vi.fn(async (command: ExecutableCommand): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => {
      const next = (command.type === "fill" || command.type === "select") && command.fieldId === "field-training"
        ? fullyFilled
        : phoneFilled;
      return {
        type: "execution_result",
        taskId: "task-1",
        snapshotId: next.id,
        commandType: command.type === "select" ? "select" : "fill",
        status: "applied",
        actualValue: command.type === "fill" ? command.value : "",
        snapshot: next,
        errors: []
      };
    });
    const service = createApplicationService({
      checkpoints,
      taskEvents: captureProgressEvents(progressEvents),
      browser: { observe: async () => form, execute },
      resolveField: async (_taskId, field, phase) => field.id === "field-phone"
        ? { status: "verified", value: "13800000000" }
        : phase === "deterministic"
          ? { status: "deferred" }
          : { status: "verified", value: "统招" },
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    const started = progressEvents.filter((event) => event.type === "operation_started");
    expect(started.find((event) => event.progress.fieldId === "field-phone")?.progress.displayPhase).toBe("deterministic_fill");
    expect(started.find((event) => event.progress.fieldId === "field-training")?.progress.displayPhase).toBe("semantic_fill");
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("persists ordered checkpoints with browser fingerprints", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createCheckpointRepository(database);

    repository.save({
      taskId: "task-1",
      state: "observing",
      url: "https://jobs.example.test/apply",
      stage: "application_form",
      snapshotId: "snapshot-1",
      fieldIds: ["field-email"],
      questions: []
    });
    repository.save({
      taskId: "task-1",
      state: "review_locked",
      url: "https://jobs.example.test/review",
      stage: "review",
      snapshotId: "snapshot-2",
      fieldIds: [],
      questions: []
    });

    expect(repository.latest("task-1")).toMatchObject({
      sequence: 2,
      state: "review_locked",
      snapshotId: "snapshot-2"
    });
    expect(repository.list("task-1").map((checkpoint) => checkpoint.sequence)).toEqual([1, 2]);
    database.close();
  });

  it("persists the full snapshot and pending content review", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createCheckpointRepository(database);
    const page = snapshot("application_form");

    repository.save({
      taskId: "task-1",
      state: "awaiting_content_review",
      url: page.url,
      stage: page.stage,
      snapshotId: page.id,
      fieldIds: [],
      questions: [],
      snapshot: page,
      contentReview: {
        id: "review-1",
        taskId: "task-1",
        fieldId: "self",
        fieldLabel: "自我评价",
        original: "原始内容",
        draft: "待审核草稿",
        reasons: ["需要确认"],
        evidence: [],
        unsupportedClaims: [],
        status: "needs_review"
      }
    });

    const reopened = createCheckpointRepository(database).latest("task-1");
    expect(reopened?.snapshot).toEqual(page);
    expect(reopened?.contentReview).toMatchObject({ id: "review-1", draft: "待审核草稿" });
    database.close();
  });

  it("automates an intermediate click and locks immediately on the review snapshot", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form = snapshot("application_form", { action: true });
    const review = snapshot("review");
    const observe = vi.fn(async () => form);
    const execute = vi.fn(async (): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: "task-1",
      snapshotId: review.id,
      commandType: "click_intermediate",
      status: "applied",
      actualValue: review.url,
      snapshot: review,
      errors: []
    }));
    const service = createApplicationService({
      checkpoints,
      browser: { observe, execute },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("review_locked");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      type: "click_intermediate",
      actionId: "action-next"
    }), expect.any(Number));
    await expect(service.requestIntermediateClick("task-1", "action-submit")).rejects.toThrow("review_locked");
    expect(checkpoints.latest("task-1")?.state).toBe("review_locked");
    database.close();
  });

  it("uploads the available resume before asking about fields that the site may parse from it", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { id: "field-resume", label: "上传简历", type: "file", required: false, options: [], currentValue: "" },
        { id: "field-name", label: "姓名", type: "text", required: true, options: [], currentValue: "" }
      ]
    };
    const parsed: FormSnapshot = {
      ...form,
      id: "snapshot-parsed",
      fields: [
        { ...form.fields[0]!, currentValue: "resume.pdf" },
        { ...form.fields[1]!, currentValue: "张三" }
      ]
    };
    const execute = vi.fn(async (): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: "task-1",
      snapshotId: parsed.id,
      commandType: "upload",
      status: "applied",
      actualValue: "resume.pdf",
      snapshot: parsed,
      errors: []
    }));
    const resolveField = vi.fn(async () => ({
      status: "needs_question" as const,
      question: "知识库中没有该字段"
    }));
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute },
      resolveField,
      resolveFileId: () => "resume-file-1",
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      type: "upload", fieldId: "field-resume", fileId: "resume-file-1"
    }), expect.any(Number));
    expect(resolveField).not.toHaveBeenCalled();
    expect(service.state("task-1").value).not.toBe("needs_questions");
    database.close();
  });

  it("hands off for human review when preview and submit is the only remaining action", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      actions: [{ id: "action-preview-submit", text: "预览并提交", class: "terminal_submit" }]
    };
    const execute = vi.fn();
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: undefined }),
      approve: () => "unused"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("review_locked");
    expect(execute).not.toHaveBeenCalled();
    database.close();
  });

  it("does not lock review while required fields are still empty", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { id: "field-name", label: "姓名", type: "text", required: true, options: [], currentValue: "" }
      ],
      actions: [{ id: "action-preview-submit", text: "预览并提交", class: "terminal_submit" }]
    };
    const execute = vi.fn(async (): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: form.taskId,
      snapshotId: form.id,
      commandType: "fill",
      status: "applied",
      actualValue: "",
      snapshot: form,
      errors: []
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: undefined }),
      approve: () => "unused"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("needs_questions");
    expect(execute).not.toHaveBeenCalled();
    database.close();
  });

  it("stops when the browser reports success but leaves a required field empty", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }
      ],
      actions: [{ id: "action-preview-submit", text: "预览并提交", class: "terminal_submit" }]
    };
    const execute = vi.fn(async (): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: form.taskId,
      snapshotId: form.id,
      commandType: "fill",
      status: "applied",
      actualValue: "13800000000",
      snapshot: form,
      errors: []
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "13800000000" }),
      approve: () => "unused"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("failed");
    expect(service.state("task-1").context.errors).toContain("required_fields_empty:手机号码");
    expect(execute).toHaveBeenCalledOnce();
    database.close();
  });

  it("clicks a Mokahr section add action and then fills the newly observed entry", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form = {
      ...snapshot("application_form"),
      actions: [{ id: "add-project", text: "添加", class: "intermediate_navigation" as const, context: "项目经历" }]
    };
    const expanded = {
      ...form,
      id: "expanded",
      fields: [{ id: "project-name", label: "项目名称", type: "text" as const, required: false, options: [], currentValue: "" }],
      actions: [{ id: "preview", text: "预览并提交", class: "terminal_submit" as const }]
    };
    const execute = vi.fn().mockResolvedValue({
      type: "execution_result", taskId: "task-1", snapshotId: expanded.id,
      commandType: "click_intermediate", status: "applied", actualValue: expanded.url,
      snapshot: expanded, errors: []
    });
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "ApplyPilot" }),
      approve: () => "approved"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: "click_intermediate", actionId: "add-project" }), expect.any(Number));
    database.close();
  });

  it("derives project entry semantics before resolving and filling repeated form fields", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { id: "project-name", label: "项目名称", type: "text", required: true, options: [], currentValue: "" },
        { id: "project-description", label: "项目描述", type: "textarea", required: true, options: [], currentValue: "" }
      ],
      actions: [{ id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const execute = vi.fn(async (command: ExecutableCommand): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: command.taskId,
      snapshotId: form.id,
      commandType: command.type,
      status: "applied",
      actualValue: command.type === "fill" ? command.value : form.url,
      snapshot: form,
      errors: []
    }));
    const resolveField = vi.fn(async (_taskId: string, field: FormField) => ({
      status: "verified" as const,
      value: field.semanticHint === "projects[0].name" ? "星迹社区" : "高并发内容社交平台"
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField,
      approve: () => "approved"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(resolveField.mock.calls.map(([, field]) => field.semanticHint)).toEqual([
      "projects[0].name",
      "projects[0].description"
    ]);
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      expect.objectContaining({ type: "fill", fieldId: "project-name", value: "星迹社区" }),
      expect.objectContaining({ type: "fill", fieldId: "project-description", value: "高并发内容社交平台" })
    ]);
    expect(service.state("task-1").value).toBe("failed");
    expect(service.state("task-1").context.errors).toContain("required_fields_empty:项目名称");
    database.close();
  });

  it("continues through successive intermediate pages until the review snapshot", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const firstPage = snapshot("application_form", { action: true });
    const secondPage: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      id: "snapshot-second-page",
      url: "https://jobs.example.test/application/step-2"
    };
    const review = snapshot("review");
    const execute = vi.fn()
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: secondPage.id,
        commandType: "click_intermediate", status: "applied", actualValue: secondPage.url,
        snapshot: secondPage, errors: []
      })
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: review.id,
        commandType: "click_intermediate", status: "applied", actualValue: review.url,
        snapshot: review, errors: []
      });
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => firstPage, execute },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: firstPage.url });
    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("review_locked");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(([command]) => command.type)).toEqual([
      "click_intermediate",
      "click_intermediate"
    ]);
    expect(checkpoints.latest("task-1")?.state).toBe("review_locked");
    database.close();
  });

  it("同页中间点击即使被误报为成功也会安全停止且不递归重跑", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form = snapshot("application_form", { action: true });
    const execute = vi.fn()
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: form.id,
        commandType: "click_intermediate", status: "applied", actualValue: form.url,
        snapshot: form, errors: []
      })
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: form.id,
        commandType: "click_intermediate", status: "failed", actualValue: form.url,
        snapshot: form, errors: ["intermediate_no_progress"]
      });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledOnce();
    expect(service.state("task-1")).toMatchObject({
      value: "failed",
      context: { errors: ["intermediate_no_progress"] }
    });
    database.close();
  });

  it("keeps a safety-blocked intermediate action terminal and non-retryable", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form = snapshot("application_form", { action: true });
    const execute = vi.fn().mockResolvedValue({
      type: "execution_result" as const,
      taskId: "task-1",
      snapshotId: form.id,
      commandType: "click_intermediate" as const,
      status: "blocked" as const,
      actualValue: null,
      snapshot: form,
      errors: ["unsafe_intermediate_action"]
    });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(service.state("task-1")).toMatchObject({
      value: "failed",
      context: { errors: ["unsafe_intermediate_action"] }
    });
    expect(service.recoveryCommands("task-1")).toEqual([]);
    database.close();
  });

  it("aggregates all field questions into one pause and resumes only after answers", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { id: "field-email", label: "邮箱", type: "text", required: true, options: [], currentValue: "" },
        { id: "field-city", label: "城市", type: "text", required: true, options: [], currentValue: "" }
      ]
    };
    const applyAnswers = vi.fn();
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async (_taskId, field) => ({
        status: "needs_question",
        question: `请补充${field.label}`
      }),
      approve: () => "unused",
      applyAnswers
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("needs_questions");
    expect(service.state("task-1").context.questions).toEqual([
      { id: "field-email", fieldId: "field-email", fieldPath: "field-email", label: "邮箱", text: "请补充邮箱", pageText: "邮箱", interpretation: "系统已识别该字段，但尚无可安全填写的已确认资料", missingInformation: "请补充邮箱", scope: "application", inputType: "text", options: [], required: true },
      { id: "field-city", fieldId: "field-city", fieldPath: "field-city", label: "城市", text: "请补充城市", pageText: "城市", interpretation: "系统已识别该字段，但尚无可安全填写的已确认资料", missingInformation: "请补充城市", scope: "application", inputType: "text", options: [], required: true }
    ]);
    expect(checkpoints.latest("task-1")?.questions).toEqual([
      { id: "field-email", fieldId: "field-email", fieldPath: "field-email", label: "邮箱", text: "请补充邮箱", pageText: "邮箱", interpretation: "系统已识别该字段，但尚无可安全填写的已确认资料", missingInformation: "请补充邮箱", scope: "application", inputType: "text", options: [], required: true },
      { id: "field-city", fieldId: "field-city", fieldPath: "field-city", label: "城市", text: "请补充城市", pageText: "城市", interpretation: "系统已识别该字段，但尚无可安全填写的已确认资料", missingInformation: "请补充城市", scope: "application", inputType: "text", options: [], required: true }
    ]);

    await service.answerQuestions("task-1", {
      "field-email": "me@example.com",
      "field-city": "杭州"
    });
    expect(applyAnswers).toHaveBeenCalledOnce();
    expect(service.state("task-1").value).toBe("observing");
    database.close();
  });

  it("rejects partial and unknown question answer sets", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { id: "field-email", label: "邮箱", type: "text", required: true, options: [], currentValue: "" },
        { id: "field-city", label: "城市", type: "text", required: true, options: [], currentValue: "" }
      ]
    };
    const applyAnswers = vi.fn();
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async (_taskId, field) => ({ status: "needs_question", question: `请补充${field.label}` }),
      approve: () => "unused",
      applyAnswers
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    await expect(service.answerQuestions("task-1", { "field-email": "me@example.com" }))
      .rejects.toThrow("incomplete_question_answers");
    await expect(service.answerQuestions("task-1", { "field-email": "me@example.com", unknown: "杭州" }))
      .rejects.toThrow("incomplete_question_answers");
    expect(applyAnswers).not.toHaveBeenCalled();
    expect(service.state("task-1").value).toBe("needs_questions");
    database.close();
  });

  it("fails closed when question answers cannot be persisted", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ id: "field-city", label: "城市", type: "text", required: true, options: [], currentValue: "" }]
    };
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "needs_question", question: "请选择城市" }),
      approve: () => "unused",
      applyAnswers: async () => { throw new Error("database unavailable"); }
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    await expect(service.answerQuestions("task-1", { "field-city": "杭州" }))
      .rejects.toThrow("answer_persistence_failed");
    expect(service.state("task-1").value).toBe("needs_questions");
    database.close();
  });

  it("refuses to leave question state without an answer persistence adapter", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ id: "field-city", label: "城市", type: "text", required: true, options: [], currentValue: "" }]
    };
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "needs_question" }),
      approve: () => "unused"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    await expect(service.answerQuestions("task-1", { "field-city": "杭州" }))
      .rejects.toThrow("answer_persistence_unavailable");
    expect(service.state("task-1").value).toBe("needs_questions");
    database.close();
  });

  it("re-observes a checkpoint on restart and rejects blind replay after page drift", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ id: "field-email", label: "邮箱", type: "text", required: true, options: [], currentValue: "" }]
    };
    checkpoints.save({
      taskId: "task-1",
      state: "observing",
      url: form.url,
      stage: form.stage,
      snapshotId: form.id,
      fieldIds: form.fields.map((field) => field.id),
      questions: []
    });
    const matchingService = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    await matchingService.resume("task-1");
    expect(matchingService.state("task-1").value).toBe("observing");

    const changed = { ...form, id: "snapshot-changed", fields: [] };
    const changedService = createApplicationService({
      checkpoints,
      browser: { observe: async () => changed, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    await expect(changedService.resume("task-1")).rejects.toThrow("checkpoint_mismatch");
    database.close();
  });

  it("recovers a transient checkpoint by observing before any navigation or mutation", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form = snapshot("application_form", { action: true });
    checkpoints.save({
      taskId: "task-1",
      state: "filling",
      url: form.url,
      stage: form.stage,
      snapshotId: form.id,
      fieldIds: [],
      questions: [],
      snapshot: form
    });
    const open = vi.fn();
    const observe = vi.fn(async () => form);
    const execute = vi.fn();
    const service = createApplicationService({
      checkpoints,
      browser: { open, observe, execute },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });

    expect(service.state("task-1").value).toBe("observing");
    expect(service.requiresRecovery("task-1")).toBe(true);
    await expect(service.openBrowser("task-1")).rejects.toThrow("checkpoint_recovery_requires_resume");
    await service.resume("task-1");

    expect(open).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(service.requiresRecovery("task-1")).toBe(false);
    database.close();
  });

  it("reserves the controlled browser before an asynchronous open completes", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    let releaseFirstOpen: (() => void) | undefined;
    const firstOpen = new Promise<void>((resolve) => { releaseFirstOpen = resolve; });
    const open = vi.fn((taskId: string) => taskId === "task-1" ? firstOpen : Promise.resolve());
    const service = createApplicationService({
      checkpoints,
      browser: { open, observe: async () => snapshot("application_form"), execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId: "task-1", applicationUrl: "https://jobs.example.test/one" });
    service.start({ taskId: "task-2", applicationUrl: "https://jobs.example.test/two" });

    const opening = service.openBrowser("task-1");
    try {
      await expect(service.openBrowser("task-2")).rejects.toThrow("browser_task_in_use");
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirstOpen?.();
      await opening;
    }
    database.close();
  });

  it("reserves the controlled browser before resuming an existing login task", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const observe = vi.fn(async () => snapshot("application_form"));
    const service = createApplicationService({
      checkpoints,
      browser: { open: vi.fn(async () => undefined), observe, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId: "task-1", applicationUrl: "https://jobs.example.test/one" });
    service.start({ taskId: "task-2", applicationUrl: "https://jobs.example.test/two" });
    await service.runUntilPause("task-1", snapshot("login"));
    await service.openBrowser("task-2");

    await expect(service.resume("task-1")).rejects.toThrow("browser_task_in_use");
    expect(observe).not.toHaveBeenCalled();

    await service.cancel("task-2");
    await service.resume("task-1");
    expect(service.activeBrowserTaskId()).toBe("task-1");
    expect(observe).toHaveBeenCalledOnce();
    database.close();
  });

  it("disposes terminal task state after its persisted task is removed", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => snapshot("application_form"), execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId: "task-1", applicationUrl: "https://jobs.example.test/apply" });

    service.dispose("task-1");

    expect(() => service.state("task-1")).toThrow("application_task_not_found");
    expect(service.activeBrowserTaskId()).toBeUndefined();
    database.close();
  });

  it("publishes every persisted browser workflow state in order", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";
    createApplicationTaskRepository(database).create({ id: taskId, applicationUrl: "https://jobs.example.test/apply" });
    const taskEvents = createTaskEventBus(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      taskId,
      fields: [{ id: "field-email", label: "邮箱", type: "text", required: true, options: [], currentValue: "" }]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-filled",
      fields: [{ ...form.fields[0]!, currentValue: "me@example.com" }]
    };
    const review: FormSnapshot = { ...snapshot("review"), taskId };
    const execute = vi.fn()
      .mockResolvedValueOnce({
        type: "execution_result", taskId, snapshotId: filled.id, commandType: "fill",
        status: "applied", actualValue: "me@example.com", snapshot: filled, errors: []
      })
      .mockResolvedValueOnce({
        type: "execution_result", taskId, snapshotId: review.id, commandType: "click_intermediate",
        status: "applied", actualValue: review.url, snapshot: review, errors: []
      });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      taskEvents,
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "me@example.com" }),
      approve: () => "approved"
    });

    service.start({ taskId, applicationUrl: form.url });
    await service.runUntilPause(taskId);

    expect(taskEvents.history(taskId).map((event) => event.state)).toEqual([
      "observing_page", "filling", "validating", "navigating", "review_locked"
    ]);
    database.close();
  });

  it("pauses for manual login and re-observes after the user resumes", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const login = snapshot("login");
    const form = snapshot("application_form", { action: true });
    const observe = vi.fn()
      .mockResolvedValueOnce(login)
      .mockResolvedValueOnce(form);
    const service = createApplicationService({
      checkpoints,
      browser: { observe, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });

    service.start({ taskId: "task-1", applicationUrl: login.url });
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("awaiting_login");

    await service.resume("task-1");
    expect(service.state("task-1").value).toBe("observing");
    expect(checkpoints.latest("task-1")).toMatchObject({
      state: "observing",
      snapshotId: form.id
    });
    database.close();
  });

  it("pauses for content review before filling a tailored self-evaluation", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      fields: [{
        id: "field-self-evaluation",
        label: "自我评价",
        type: "textarea",
        required: true,
        options: [],
        currentValue: ""
      }]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-filled",
      fields: [{ ...form.fields[0]!, currentValue: "面向岗位微调后的自我评价" }]
    };
    const review = snapshot("review");
    const execute = vi.fn(async (command: { type: string }): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => {
      const nextSnapshot = command.type === "fill" ? filled : review;
      return {
        type: "execution_result",
        taskId: "task-1",
        snapshotId: nextSnapshot.id,
        commandType: command.type === "fill" ? "fill" : "click_intermediate",
        status: "applied",
        actualValue: command.type === "fill" ? "面向岗位微调后的自我评价" : review.url,
        snapshot: nextSnapshot,
        errors: []
      };
    });
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute },
      resolveField: async () => ({
        status: "verified",
        value: "面向岗位微调后的自我评价",
        requiresContentReview: true
      }),
      approve: () => "approved",
      applyAnswers: vi.fn(),
      validateContentReview: () => []
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("awaiting_content_review");
    expect(execute).not.toHaveBeenCalled();

    await service.approveReview("task-1", service.contentReview("task-1")!.id);
    expect(service.state("task-1").value).toBe("filling");
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("validates content review ids and persists the edited value before filling", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      fields: [{
        id: "field-self-evaluation",
        label: "自我评价",
        type: "textarea",
        required: true,
        options: [],
        currentValue: ""
      }]
    };
    const applyAnswers = vi.fn();
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({
        status: "verified",
        value: "面向岗位微调后的自我评价",
        requiresContentReview: true
      }),
      approve: () => "unused",
      applyAnswers,
      validateContentReview: () => []
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    const review = service.contentReview("task-1");
    expect(review).toMatchObject({ draft: "面向岗位微调后的自我评价" });

    await expect(service.approveReview("task-1", "wrong-review-id", "用户修订后的自我评价"))
      .rejects.toThrow("content_review_mismatch");
    expect(service.state("task-1").value).toBe("awaiting_content_review");

    await service.approveReview("task-1", review!.id, "用户修订后的自我评价");
    expect(applyAnswers).toHaveBeenCalledWith(
      "task-1",
      { "field-self-evaluation": "用户修订后的自我评价" },
      [expect.objectContaining({ id: "field-self-evaluation" })]
    );
    expect(service.state("task-1").value).toBe("filling");
    database.close();
  });

  it("rejects an edited review that introduces unsupported claims", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ id: "self", label: "自我评价", type: "textarea", required: true, options: [], currentValue: "" }]
    };
    const applyAnswers = vi.fn();
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({
        status: "verified",
        value: "具备 Java 项目经验",
        requiresContentReview: true,
        contentReview: { original: "具备 Java 项目经验", reasons: ["岗位匹配"], evidence: [], unsupportedClaims: [], status: "needs_review" }
      }),
      approve: () => "unused",
      applyAnswers,
      validateContentReview: (_review, value) => value.includes("Rust") ? ["Rust"] : []
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    const review = service.contentReview("task-1")!;
    await expect(service.approveReview("task-1", review.id, "具备 Rust 项目经验"))
      .rejects.toThrow("content_review_unsupported_edit");
    expect(applyAnswers).not.toHaveBeenCalled();
    expect(service.state("task-1").value).toBe("awaiting_content_review");
    database.close();
  });

  it("refuses content approval when fact validation is unavailable", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ id: "self", label: "自我评价", type: "textarea", required: true, options: [], currentValue: "" }]
    };
    const applyAnswers = vi.fn();
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "原始内容", requiresContentReview: true }),
      approve: () => "unused",
      applyAnswers
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    const review = service.contentReview("task-1")!;
    await expect(service.approveReview("task-1", review.id, "编辑内容"))
      .rejects.toThrow("content_review_validation_unavailable");
    expect(applyAnswers).not.toHaveBeenCalled();
    database.close();
  });

  it("scopes content review ids to their task", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const formFor = (taskId: string): FormSnapshot => ({
      ...snapshot("application_form", { action: true }),
      id: `snapshot-${taskId}`,
      taskId,
      fields: [{ id: "self", label: "自我评价", type: "textarea", required: true, options: [], currentValue: "" }]
    });
    let current = formFor("task-a");
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => current, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "草稿", requiresContentReview: true }),
      approve: () => "unused",
      applyAnswers: vi.fn()
    });
    service.start({ taskId: "task-a", applicationUrl: current.url });
    await service.runUntilPause("task-a");
    const reviewA = service.contentReview("task-a")!;

    current = formFor("task-b");
    service.start({ taskId: "task-b", applicationUrl: current.url });
    await service.runUntilPause("task-b");
    await expect(service.rejectReview("task-b", reviewA.id)).rejects.toThrow("content_review_mismatch");
    expect(service.state("task-b").value).toBe("awaiting_content_review");
    database.close();
  });

  it("restores a pending content review after a process restart", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ id: "self", label: "自我评价", type: "textarea", required: true, options: [], currentValue: "" }]
    };
    const first = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "待审核草稿", requiresContentReview: true }),
      approve: () => "unused",
      applyAnswers: vi.fn(),
      validateContentReview: () => []
    });
    first.start({ taskId: "task-1", applicationUrl: form.url });
    await first.runUntilPause("task-1");
    const review = first.contentReview("task-1")!;

    const applyAnswers = vi.fn();
    const restarted = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "待审核草稿" }),
      approve: () => "unused",
      applyAnswers,
      validateContentReview: () => []
    });

    expect(restarted.state("task-1").value).toBe("awaiting_content_review");
    expect(restarted.contentReview("task-1")).toEqual(review);
    await restarted.approveReview("task-1", review.id, "重启后修订值");
    expect(applyAnswers).toHaveBeenCalledWith("task-1", { self: "重启后修订值" }, form.fields);
    database.close();
  });

  it.each(["filling", "validating", "navigating"] as const)(
    "restores transient %s checkpoints only as observing",
    (state) => {
      const database = new Database(":memory:");
      migrateDatabase(database);
      const checkpoints = createCheckpointRepository(database);
      const form = snapshot("application_form", { action: true });
      checkpoints.save({
        taskId: "task-1",
        state,
        url: form.url,
        stage: form.stage,
        snapshotId: form.id,
        fieldIds: [],
        questions: [],
        snapshot: form
      });
      const restarted = createApplicationService({
        checkpoints,
        browser: { observe: async () => form, execute: vi.fn() },
        resolveField: async () => ({ status: "verified", value: "" }),
        approve: () => "unused",
        applyAnswers: vi.fn()
      });

      expect(restarted.state("task-1").value).toBe("observing");
      database.close();
    }
  );

  it("restores cancelled checkpoints as cancelled", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form = snapshot("application_form");
    checkpoints.save({
      taskId: "task-1",
      state: "cancelled",
      url: form.url,
      stage: form.stage,
      snapshotId: form.id,
      fieldIds: [],
      questions: [],
      snapshot: form
    });
    const restarted = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused",
      applyAnswers: vi.fn()
    });

    expect(restarted.state("task-1").value).toBe("cancelled");
    database.close();
  });

  it("显式取消会终止当前自动操作且旧结果不能继续后续自动化", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      fields: [{ id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }]
    };
    let finishFill!: (result: WorkerResponse & { type: "execution_result" }) => void;
    const execute = vi.fn().mockImplementationOnce(() => new Promise<WorkerResponse & { type: "execution_result" }>((resolve) => {
      finishFill = resolve;
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "自动值" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    const running = service.runUntilPause("task-1");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.cancel("task-1");

    expect(service.state("task-1").value).toBe("cancelled");
    expect(service.progress("task-1").busy).toBe(false);
    finishFill({
      type: "execution_result", taskId: "task-1", snapshotId: form.id,
      commandType: "fill", status: "applied", actualValue: "自动值",
      snapshot: form, errors: []
    });
    await running;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.state("task-1").value).toBe("cancelled");
    database.close();
  });

  it("解析字段期间的用户活动会暂停并使排队运行失效", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      fields: [{ id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }]
    };
    let finishResolution!: (decision: { status: "verified"; value: string }) => void;
    const resolveField = vi.fn(() => new Promise<{ status: "verified"; value: string }>((resolve) => {
      finishResolution = resolve;
    }));
    const execute = vi.fn();
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField,
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    const running = service.runUntilPause("task-1", form);
    await vi.waitFor(() => expect(resolveField).toHaveBeenCalledOnce());

    await service.handleActivity({
      type: "user_activity", taskId: "task-1", fieldId: "field-phone", activity: "input"
    });

    expect(service.progress("task-1")).toMatchObject({ status: "paused", busy: false });
    finishResolution({ status: "verified", value: "自动值" });
    await running;
    expect(execute).not.toHaveBeenCalled();
    expect(service.state("task-1").value).toBe("observing");
    database.close();
  });

  it("用户活动会取消当前自动填写，页面稳定回读后安全续跑", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      fields: [{ id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }]
    };
    const manuallyFilled: FormSnapshot = {
      ...form,
      id: "snapshot-manual",
      fields: [{ ...form.fields[0]!, currentValue: "已由用户填写" }]
    };
    const review = snapshot("review");
    const execute = vi.fn()
      .mockImplementationOnce(() => new Promise<never>(() => undefined))
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: review.id,
        commandType: "click_intermediate", status: "applied", actualValue: review.url,
        snapshot: review, errors: []
      });
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockResolvedValue(manuallyFilled);
    const service = createApplicationService({
      checkpoints,
      browser: { observe, execute },
      resolveField: async () => ({ status: "verified", value: "自动值" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    const running = service.runUntilPause("task-1");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.handleActivity({
      type: "user_activity", taskId: "task-1", fieldId: "field-phone", activity: "input"
    });
    await running;

    expect(service.progress("task-1")).toMatchObject({ status: "paused", busy: false });
    await service.handleActivity({ type: "page_stable", taskId: "task-1", fingerprint: "structure-1" });

    await vi.waitFor(() => expect(service.state("task-1").value).toBe("review_locked"));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({ type: "click_intermediate" });
    database.close();
  });

  it("用户手动跳到同站新表单后由稳定事件重新观察并安全续跑", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const firstPage: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      id: "snapshot-contact",
      url: "https://jobs.example.test/apply/contact",
      fields: [{
        id: "field-phone",
        label: "手机号码",
        type: "text",
        required: true,
        options: [],
        currentValue: ""
      }]
    };
    const secondPage: FormSnapshot = {
      ...snapshot("application_form"),
      id: "snapshot-profile",
      url: "https://jobs.example.test/apply/profile",
      fields: [{
        id: "field-email",
        label: "邮箱",
        type: "text",
        required: true,
        options: [],
        currentValue: ""
      }],
      actions: [{ id: "action-submit", text: "提交申请", class: "terminal_submit" }]
    };
    const filledSecondPage: FormSnapshot = {
      ...secondPage,
      id: "snapshot-profile-filled",
      fields: [{ ...secondPage.fields[0]!, currentValue: "agent@example.com" }]
    };
    const execute = vi.fn(async (command: ExecutableCommand) => {
      if (command.type === "fill" && command.fieldId === "field-phone") {
        return new Promise<never>(() => undefined);
      }
      if (command.type !== "fill" || command.fieldId !== "field-email") {
        throw new Error(`不应执行命令：${command.type}`);
      }
      return {
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: filledSecondPage.id,
        commandType: "fill" as const,
        status: "applied" as const,
        actualValue: "agent@example.com",
        snapshot: filledSecondPage,
        errors: []
      };
    });
    const observe = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValue(secondPage);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField: async (_taskId, field) => ({
        status: "verified",
        value: field.id === "field-email" ? "agent@example.com" : "13800138000"
      }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: firstPage.url });
    const running = service.runUntilPause("task-1");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.handleActivity({
      type: "user_activity", taskId: "task-1", fieldId: "action-next", activity: "click"
    });
    await running;
    await service.handleActivity({
      type: "page_stable", taskId: "task-1", fingerprint: "profile-page"
    });

    expect(observe).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({ type: "fill", fieldId: "field-email" });
    expect(execute.mock.calls.flatMap(([command]) =>
      "actionId" in command ? [command.actionId] : [])).not.toContain("action-submit");
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("用户手动跳到同源非申请页面后保持暂停且不自动填写", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const firstPage: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      id: "snapshot-contact",
      url: "https://jobs.example.test/apply/contact",
      fields: [{ id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }]
    };
    const jobsPage: FormSnapshot = {
      ...snapshot("application_form"),
      id: "snapshot-jobs",
      url: "https://jobs.example.test/jobs",
      fields: [{ id: "field-keyword", label: "搜索岗位", type: "text", required: false, options: [], currentValue: "" }]
    };
    const execute = vi.fn()
      .mockImplementationOnce(() => new Promise<never>(() => undefined))
      .mockResolvedValueOnce({
        type: "execution_result",
        taskId: "task-1",
        snapshotId: jobsPage.id,
        commandType: "fill",
        status: "failed",
        actualValue: "",
        snapshot: jobsPage,
        errors: ["readback_mismatch"]
      });
    const observe = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValue(jobsPage);
    const resolveField = vi.fn(async () => ({ status: "verified" as const, value: "不应填写" }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField,
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: firstPage.url });
    const running = service.runUntilPause("task-1");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.handleActivity({ type: "user_activity", taskId: "task-1", fieldId: "action-back", activity: "click" });
    await running;
    resolveField.mockClear();
    execute.mockClear();
    await service.handleActivity({ type: "page_stable", taskId: "task-1", fingerprint: "jobs-page" });

    expect(service.progress("task-1").status).toBe("paused");
    expect(resolveField).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    database.close();
  });

  it("Mokahr 从申请表 hash 跳回岗位列表后保持暂停", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const applicationPage: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      id: "snapshot-mokahr-application",
      url: "https://app.mokahr.com/m/campus-recruitment/dji/143359#/application/contact",
      fields: [{ id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }]
    };
    const jobsPage: FormSnapshot = {
      ...snapshot("application_form"),
      id: "snapshot-mokahr-jobs",
      url: "https://app.mokahr.com/m/campus-recruitment/dji/143359#/jobs",
      fields: [{ id: "field-keyword", label: "搜索岗位", type: "text", required: false, options: [], currentValue: "" }]
    };
    const execute = vi.fn()
      .mockImplementationOnce(() => new Promise<never>(() => undefined))
      .mockResolvedValueOnce({ type: "execution_result", taskId: "task-1", snapshotId: jobsPage.id, commandType: "fill", status: "failed", actualValue: "", snapshot: jobsPage, errors: ["readback_mismatch"] });
    const resolveField = vi.fn(async () => ({ status: "verified" as const, value: "不应填写" }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: vi.fn().mockResolvedValueOnce(applicationPage).mockResolvedValue(jobsPage), execute },
      resolveField,
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: applicationPage.url });
    const running = service.runUntilPause("task-1");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.handleActivity({ type: "user_activity", taskId: "task-1", fieldId: "action-back", activity: "click" });
    await running;
    resolveField.mockClear();
    execute.mockClear();
    await service.handleActivity({ type: "page_stable", taskId: "task-1", fingerprint: "mokahr-jobs" });

    expect(service.progress("task-1").status).toBe("paused");
    expect(resolveField).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    database.close();
  });

  it("离开登录页后由稳定事件自动恢复既有流程", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const login = snapshot("login");
    const review = snapshot("review");
    const observe = vi.fn()
      .mockResolvedValueOnce(login)
      .mockResolvedValue(review);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId: "task-1", applicationUrl: login.url });
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("awaiting_login");

    await service.handleActivity({
      type: "user_activity", taskId: "task-1", fieldId: "field-password", activity: "input"
    });
    expect(service.progress("task-1").status).toBe("paused");

    await service.handleActivity({ type: "page_stable", taskId: "task-1", fingerprint: "review-structure" });

    expect(service.state("task-1").value).toBe("review_locked");
    expect(observe).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("普通控件点击会立即暂停当前自动操作", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      fields: [{ id: "field-email", label: "邮箱", type: "text", required: true, options: [], currentValue: "" }]
    };
    const execute = vi.fn(() => new Promise<never>(() => undefined));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "agent@example.com" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    const running = service.runUntilPause("task-1", form);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.handleActivity({
      type: "user_activity", taskId: "task-1", fieldId: "action_opaque", activity: "click"
    });

    await running;
    expect(service.progress("task-1")).toMatchObject({
      status: "paused", busy: false, stalledFieldId: "field-email",
      recovery: ["retry_current", "manual_done", "cancel"]
    });
    database.close();
  });

  it("生产活动订阅将观察失败投影为可见的 PAGE_ERROR 暂停事件", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";
    const taskEvents = createTaskEventBus(database);
    let activityListener: ((activity: WorkerActivity) => void) | undefined;
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      taskEvents,
      browser: {
        observe: vi.fn(async () => { throw new Error("browser observation failed"); }),
        execute: vi.fn(),
        onActivity(listener) {
          activityListener = listener;
          return () => undefined;
        }
      },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });

    activityListener?.({ type: "page_stable", taskId, fingerprint: "page_fingerprint" });

    await vi.waitFor(() => expect(service.progress(taskId)).toMatchObject({
      status: "paused",
      busy: false,
      stalledFieldId: "page",
      recovery: ["retry_current", "cancel"],
      lastResult: { operation: { status: "failed", errorCode: "PAGE_ERROR" } }
    }));
    expect(taskEvents.replayAll(taskId).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "operation_failed",
        operation: expect.objectContaining({ status: "failed", errorCode: "PAGE_ERROR" })
      }),
      expect.objectContaining({ type: "task_paused" })
    ]));
    database.close();
  });

  it("观察失败暂停后可通过安全重试重新观察并进入审核锁定", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";
    let activityListener: ((activity: WorkerActivity) => void) | undefined;
    const review = { ...snapshot("review"), taskId };
    const observe = vi.fn()
      .mockRejectedValueOnce(new Error("browser observation failed"))
      .mockResolvedValueOnce(review);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: {
        observe,
        execute: vi.fn(),
        onActivity(listener) {
          activityListener = listener;
          return () => undefined;
        }
      },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });
    activityListener?.({ type: "page_stable", taskId, fingerprint: "page_fingerprint" });
    await vi.waitFor(() => expect(service.recoveryCommands(taskId)).toEqual(["retry_current", "cancel"]));

    await service.retryCurrent(taskId);

    expect(service.state(taskId).value).toBe("review_locked");
    expect(service.progress(taskId)).toMatchObject({ status: "idle", recovery: [] });
    expect(observe).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("invalidates a paused browser execution before retrying the current task", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";
    const login = { ...snapshot("login"), taskId };
    const observe = vi.fn(async () => login);
    const invalidateExecution = vi.fn(async (_taskId: string, _epoch: number) => undefined);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute: vi.fn(), invalidateExecution },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId, applicationUrl: login.url });
    await service.runUntilPause(taskId);

    await service.handleActivity({ type: "user_activity", taskId, fieldId: "field-password", activity: "input" });
    await vi.waitFor(() => expect(invalidateExecution).toHaveBeenCalledTimes(1));

    await service.retryCurrent(taskId);

    expect(invalidateExecution).toHaveBeenCalledTimes(2);
    const pauseEpoch = invalidateExecution.mock.calls[0]?.[1];
    const retryEpoch = invalidateExecution.mock.calls[1]?.[1];
    expect(retryEpoch).toBeGreaterThan(pauseEpoch!);
    expect(service.state(taskId).value).toBe("awaiting_login");
    database.close();
  });

  it("生产活动订阅隔离失败投影异常且不产生未处理拒绝", async () => {
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";
    let activityListener: ((activity: WorkerActivity) => void) | undefined;
    const checkpoints = {
      latest: () => undefined,
      list: () => [],
      save: vi.fn(() => { throw new Error("checkpoint write failed"); }),
      saveProgress: vi.fn(() => { throw new Error("progress write failed"); }),
      latestProgress: () => undefined
    };
    createApplicationService({
      checkpoints,
      browser: {
        observe: vi.fn(async () => { throw new Error("browser observation failed"); }),
        execute: vi.fn(),
        onActivity(listener) {
          activityListener = listener;
          return () => undefined;
        }
      },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });

    expect(() => activityListener?.({ type: "page_stable", taskId, fingerprint: "page_fingerprint" })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("records a verified field as filled after successful readback", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ id: "review", text: "预览", class: "terminal_submit" }]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-filled",
      fields: [{ ...form.fields[0]!, currentValue: "13800000000" }]
    };
    const checkpoints = createCheckpointRepository(database);
    const service = createApplicationService({
      checkpoints,
      browser: {
        observe: vi.fn(async () => form),
        execute: vi.fn(async () => ({
          type: "execution_result" as const,
          taskId: "task-1",
          snapshotId: filled.id,
          commandType: "fill" as const,
          status: "applied" as const,
          actualValue: "13800000000",
          snapshot: filled,
          errors: []
        }))
      },
      resolveField: async () => ({
        status: "verified" as const,
        value: "13800000000",
        assessment: {
          fieldId: "field-phone", label: "手机号码", semantic: "basics.phone",
          status: "ready" as const, source: "exact" as const, confidence: 1,
          reason: "精确匹配", evidence: []
        }
      }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(service.fieldCoverage("task-1")).toMatchObject({
      total: 1,
      filled: 1,
      fields: [expect.objectContaining({ fieldId: "field-phone", status: "filled" })]
    });
    expect(checkpoints.latest("task-1")?.fieldCoverage?.filled).toBe(1);
    database.close();
  });

  it("replaces a prior missing assessment after the user fills the field in the controlled browser", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ id: "field-manual", label: "Manual field", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ id: "review", text: "Review", class: "terminal_submit" }]
    };
    const manuallyFilled: FormSnapshot = {
      ...form,
      id: "snapshot-manual",
      fields: [{ ...form.fields[0]!, currentValue: "user value" }]
    };
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockResolvedValue(manuallyFilled);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute: vi.fn() },
      resolveField: async () => ({
        status: "needs_question" as const,
        assessment: {
          fieldId: "field-manual", label: "Manual field", status: "missing" as const,
          source: "none" as const, confidence: 0, reason: "missing", evidence: []
        }
      }),
      approve: () => "unused"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    expect(service.fieldCoverage("task-1")?.fields).toContainEqual(expect.objectContaining({
      fieldId: "field-manual", status: "missing"
    }));

    await service.resumeWithProfile("task-1");

    expect(service.fieldCoverage("task-1")?.fields).toContainEqual(expect.objectContaining({
      fieldId: "field-manual", status: "filled", source: "user", confidence: 1
    }));
    database.close();
  });

});
