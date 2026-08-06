import { describe, expect, it } from "vitest";
import {
  ExecutableCommandSchema,
  FormFieldSchema,
  FormSnapshotSchema,
  WorkerActivitySchema,
  WorkerRequestSchema,
  WorkerResponseSchema
} from "./browser.js";

describe("browser command contracts", () => {
  it("preserves optional action context for site adapters", () => {
    expect(FormSnapshotSchema.parse({
      id: "snapshot-1", taskId: "task-1", url: "https://example.test/apply", title: "申请",
      stage: "application_form", fields: [],
      actions: [{ id: "action-add", text: "添加", class: "unknown_side_effect", context: "项目经历" }],
      errors: []
    }).actions[0]?.context).toBe("项目经历");
  });

  it("accepts redacted user activity without the input value", () => {
    expect(WorkerActivitySchema.parse({
      type: "user_activity",
      taskId: "task-1",
      fieldId: "password",
      activity: "input"
    })).toEqual({
      type: "user_activity",
      taskId: "task-1",
      fieldId: "password",
      activity: "input"
    });
  });

  it("requires every worker activity variant to carry a task id", () => {
    expect(WorkerActivitySchema.safeParse({ type: "page_changed" }).success).toBe(false);
    expect(WorkerActivitySchema.safeParse({ type: "page_stable", fingerprint: "fp-1" }).success).toBe(false);
    expect(WorkerActivitySchema.safeParse({ type: "user_activity", fieldId: "field-phone", activity: "input" }).success).toBe(false);
    expect(WorkerActivitySchema.safeParse({ type: "worker_connected" }).success).toBe(false);
    expect(WorkerActivitySchema.safeParse({ type: "worker_disconnected" }).success).toBe(false);
    expect(WorkerActivitySchema.safeParse({ type: "page_unstable" }).success).toBe(false);
  });

  it("accepts only a redacted unstable-page activity", () => {
    expect(WorkerActivitySchema.parse({
      type: "page_unstable",
      taskId: "task-1",
      fingerprint: "page_opaque"
    })).toEqual({
      type: "page_unstable",
      taskId: "task-1",
      fingerprint: "page_opaque"
    });
    expect(WorkerActivitySchema.safeParse({
      type: "page_unstable",
      taskId: "task-1",
      fingerprint: "page_opaque",
      value: "secret"
    }).success).toBe(false);
  });

  it("rejects sensitive values and mutation details in valid worker activity", () => {
    expect(WorkerActivitySchema.safeParse({
      type: "user_activity",
      taskId: "task-1",
      fieldId: "password",
      activity: "input",
      value: "secret",
      selector: "#password",
      coordinates: { x: 10, y: 20 }
    }).success).toBe(false);
  });

  it("rejects browser mutation details from worker activity", () => {
    expect(WorkerActivitySchema.safeParse({
      type: "page_stable",
      taskId: "task-1",
      fingerprint: "fp-1",
      selector: "#submit",
      coordinates: { x: 10, y: 20 }
    }).success).toBe(false);
  });

  it("accepts only finite worker disconnect error codes", () => {
    expect(WorkerActivitySchema.safeParse({
      type: "worker_disconnected",
      taskId: "task-1",
      code: "WORKER_EXITED"
    }).success).toBe(true);
    expect(WorkerActivitySchema.safeParse({
      type: "worker_disconnected",
      taskId: "task-1",
      code: "123456"
    }).success).toBe(false);
    expect(WorkerActivitySchema.safeParse({
      type: "worker_disconnected",
      taskId: "task-1",
      code: "任意断开消息"
    }).success).toBe(false);
  });

  it("rejects a form field without currentValue", () => {
    expect(FormFieldSchema.safeParse({
      id: "field-name",
      label: "Name",
      type: "text",
      required: true,
      options: []
    }).success).toBe(false);
  });

  it("rejects a fill command without value", () => {
    expect(ExecutableCommandSchema.safeParse({
      type: "fill",
      taskId: "task-1",
      snapshotId: "snapshot-1",
      fieldId: "field-name",
      approval: "approval-1"
    }).success).toBe(false);
  });

  it("accepts explicitly undefined unknown values", () => {
    expect(FormFieldSchema.safeParse({
      id: "field-name",
      label: "Name",
      type: "text",
      required: true,
      options: [],
      currentValue: undefined
    }).success).toBe(true);
    expect(ExecutableCommandSchema.safeParse({
      type: "fill",
      taskId: "task-1",
      snapshotId: "snapshot-1",
      fieldId: "field-name",
      value: undefined,
      approval: "approval-1"
    }).success).toBe(true);
  });

  it("accepts only the closed DJI semantic source marker", () => {
    expect(FormFieldSchema.safeParse({
      id: "field-school",
      label: "School",
      type: "text",
      required: true,
      options: [],
      currentValue: "",
      semanticHint: "education[0].institution",
      semanticSource: "dji_catalog"
    }).success).toBe(true);
    expect(FormFieldSchema.safeParse({
      id: "field-school",
      label: "School",
      type: "text",
      required: true,
      options: [],
      currentValue: "",
      semanticHint: "education[0].institution",
      semanticSource: "other_catalog"
    }).success).toBe(false);
  });

  it("rejects terminal submit because it is not executable", () => {
    expect(ExecutableCommandSchema.safeParse({
      type: "submit",
      taskId: "task-1",
      actionId: "final"
    }).success).toBe(false);
  });

  it("accepts fill and intermediate-click commands with opaque IDs", () => {
    expect(ExecutableCommandSchema.safeParse({
      type: "fill",
      taskId: "task-1",
      snapshotId: "snapshot-1",
      fieldId: "field-name",
      value: "Ada Lovelace",
      approval: "approval-1"
    }).success).toBe(true);
    expect(ExecutableCommandSchema.safeParse({
      type: "click_intermediate",
      taskId: "task-1",
      snapshotId: "snapshot-1",
      actionId: "action-save",
      approval: "approval-2"
    }).success).toBe(true);
  });

  it("rejects arbitrary browser scripting", () => {
    expect(ExecutableCommandSchema.safeParse({
      type: "evaluate",
      taskId: "task-1",
      script: "document.querySelector('form').submit()"
    }).success).toBe(false);
  });

  it("allows only closed browser lifecycle messages", () => {
    expect(WorkerRequestSchema.safeParse({
      type: "handshake",
      approvalKey: "a".repeat(43)
    }).success).toBe(true);
    expect(WorkerRequestSchema.safeParse({
      type: "open",
      taskId: "task-1",
      url: "https://jobs.example.test/apply"
    }).success).toBe(true);
    expect(WorkerRequestSchema.safeParse({ type: "shutdown" }).success).toBe(true);
    expect(WorkerRequestSchema.parse({ type: "release_task", taskId: "task-1" })).toEqual({
      type: "release_task",
      taskId: "task-1"
    });
    expect(WorkerRequestSchema.safeParse({
      type: "release_task",
      taskId: "task-1",
      force: true
    }).success).toBe(false);
    expect(WorkerRequestSchema.safeParse({
      type: "handshake",
      approvalKey: "too-short"
    }).success).toBe(false);
    expect(WorkerResponseSchema.safeParse({ type: "ready" }).success).toBe(true);
    expect(WorkerResponseSchema.safeParse({ type: "stopped" }).success).toBe(true);
    expect(WorkerResponseSchema.parse({ type: "released", taskId: "task-1" })).toEqual({
      type: "released",
      taskId: "task-1"
    });
    expect(WorkerResponseSchema.safeParse({
      type: "activity",
      activity: { type: "page_stable", taskId: "task-1", fingerprint: "page-safe" }
    }).success).toBe(true);
    expect(WorkerResponseSchema.safeParse({
      type: "activity",
      activity: { type: "page_stable", taskId: "task-1", fingerprint: "page-safe", value: "secret" }
    }).success).toBe(false);
    expect(WorkerResponseSchema.safeParse({
      type: "opened",
      taskId: "task-1",
      url: "https://jobs.example.test/apply",
      title: "招聘申请"
    }).success).toBe(true);
    expect(WorkerResponseSchema.safeParse({
      type: "worker_error",
      code: "INVALID_URL",
      message: "仅允许 HTTP 或 HTTPS 地址"
    }).success).toBe(true);
    expect(WorkerRequestSchema.safeParse({ type: "goto", url: "file:///secret" }).success).toBe(false);
  });

  it("requires execution results to include the browser readback value", () => {
    expect(WorkerResponseSchema.safeParse({
      type: "execution_result",
      taskId: "task-1",
      snapshotId: "snapshot-2",
      commandType: "fill",
      status: "applied",
      snapshot: {
        id: "snapshot-2",
        taskId: "task-1",
        url: "https://jobs.example.test/apply",
        title: "招聘申请",
        stage: "application_form",
        fields: [],
        actions: [],
        errors: []
      },
      errors: []
    }).success).toBe(false);
  });

  it("requires execution epochs and accepts only monotonic invalidation messages", () => {
    const command = {
      type: "fill" as const,
      taskId: "task-1",
      snapshotId: "snapshot-1",
      fieldId: "field-name",
      value: "Ada Lovelace",
      approval: "approval-1"
    };

    expect(WorkerRequestSchema.safeParse({ type: "execute", command }).success).toBe(false);
    expect(WorkerRequestSchema.safeParse({
      type: "execute",
      executionEpoch: 3,
      command
    }).success).toBe(true);
    expect(WorkerRequestSchema.safeParse({
      type: "invalidate_execution",
      taskId: "task-1",
      executionEpoch: 4
    }).success).toBe(true);
    expect(WorkerRequestSchema.safeParse({
      type: "invalidate_execution",
      taskId: "task-1",
      executionEpoch: -1
    }).success).toBe(false);
  });
});
