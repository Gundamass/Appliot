import { describe, expect, it } from "vitest";
import {
  ChallengeDiagnosticSchema,
  DomBoundarySchema,
  ExecutableCommandSchema,
  FormFieldSchema,
  FormSnapshotSchema,
  StableExecutionErrorCodeSchema,
  WorkerActivitySchema,
  WorkerRequestSchema,
  WorkerResponseSchema
} from "./browser.js";
import {
  FilterPlanSchema,
  JobPageSnapshotSchema
} from "./job-matching.js";

const nodeRef = {
  documentId: "document-00000001",
  nodeId: "node-000000000001",
  observedAt: 7
};

describe("browser command contracts", () => {
  it("accepts closed job observation and mutation IPC contracts", () => {
    const plan = FilterPlanSchema.parse({
      source: "moka",
      adapterVersion: "moka-job-v1",
      mapped: [{ criterionIndex: 0, key: "location", values: ["深圳"] }],
      localOnly: []
    });
    const snapshot = JobPageSnapshotSchema.parse({
      id: "job-snapshot-1",
      ownerId: "jm-1",
      url: "https://jobs.example.test/list",
      title: "岗位列表",
      capturedAt: "2026-08-16T00:00:00.000Z",
      entryHint: "job_list",
      visibleText: ["岗位列表", "Java 工程师"],
      jobCards: [],
      filterState: [{ key: "location", values: ["深圳"] }],
      pagination: { kind: "page", current: 1, hasNext: true },
      boundaries: []
    });

    expect(WorkerRequestSchema.parse({
      type: "capture_job_snapshot",
      ownerId: "jm-1"
    })).toEqual({ type: "capture_job_snapshot", ownerId: "jm-1" });
    expect(WorkerRequestSchema.parse({
      type: "apply_job_filters",
      ownerId: "jm-1",
      plan,
      executionEpoch: 3
    })).toMatchObject({ type: "apply_job_filters", executionEpoch: 3 });
    expect(WorkerRequestSchema.parse({
      type: "advance_job_page",
      ownerId: "jm-1",
      cursor: "page-2",
      executionEpoch: 3
    })).toMatchObject({ type: "advance_job_page", cursor: "page-2" });
    expect(WorkerResponseSchema.parse({ type: "job_snapshot", snapshot })).toEqual({
      type: "job_snapshot",
      snapshot
    });
    expect(WorkerResponseSchema.parse({
      type: "job_filter_result",
      ownerId: "jm-1",
      filterState: snapshot.filterState,
      snapshot
    })).toMatchObject({ type: "job_filter_result", ownerId: "jm-1" });
    expect(WorkerResponseSchema.parse({
      type: "job_page_advanced",
      ownerId: "jm-1",
      snapshot
    })).toMatchObject({ type: "job_page_advanced", ownerId: "jm-1" });
  });

  it("rejects unversioned job mutations and sensitive snapshot details", () => {
    expect(WorkerRequestSchema.safeParse({
      type: "apply_job_filters",
      ownerId: "jm-1",
      plan: { source: "moka", adapterVersion: "v1", mapped: [], localOnly: [] }
    }).success).toBe(false);
    expect(WorkerRequestSchema.safeParse({
      type: "advance_job_page",
      ownerId: "jm-1",
      executionEpoch: 1,
      selector: ".next"
    }).success).toBe(false);
  });

  it("parses sanitized challenge diagnostics and DOM boundaries", () => {
    const challenge = {
      kind: "captcha",
      detectedAt: "2026-08-15T00:00:00.000Z",
      reasonCode: "moka_captcha_accessible_name"
    } as const;
    const boundary = {
      kind: "iframe",
      visible: true,
      interactive: true,
      reasonCode: "visible_iframe"
    } as const;

    expect(ChallengeDiagnosticSchema.parse(challenge)).toEqual(challenge);
    expect(DomBoundarySchema.parse(boundary)).toEqual(boundary);
    expect(FormSnapshotSchema.parse({
      id: "snapshot-challenge",
      taskId: "task-1",
      url: "https://example.test/apply",
      title: "Challenge",
      stage: "unknown",
      frameRef: { documentId: nodeRef.documentId, kind: "main" },
      mutationEpoch: nodeRef.observedAt,
      boundaries: [boundary],
      challenge,
      fields: [],
      actions: [],
      errors: []
    })).toMatchObject({ boundaries: [boundary], challenge });
  });

  it("rejects sensitive challenge and boundary details", () => {
    const challenge = {
      kind: "captcha",
      detectedAt: "2026-08-15T00:00:00.000Z",
      reasonCode: "moka_captcha_accessible_name"
    } as const;
    const boundary = {
      kind: "shadow_root",
      visible: true,
      interactive: true,
      reasonCode: "interactive_shadow_root"
    } as const;

    for (const extra of [
      { text: "captcha answer" },
      { html: "<input>" },
      { selector: "#captcha" },
      { coordinates: { x: 10, y: 20 } }
    ]) {
      expect(ChallengeDiagnosticSchema.safeParse({ ...challenge, ...extra }).success).toBe(false);
      expect(DomBoundarySchema.safeParse({ ...boundary, ...extra }).success).toBe(false);
    }
  });

  it("limits each snapshot to fifty DOM boundaries", () => {
    const boundary = {
      kind: "iframe",
      visible: false,
      interactive: false,
      reasonCode: "hidden_iframe"
    } as const;
    const snapshot = {
      id: "snapshot-boundaries",
      taskId: "task-1",
      url: "https://example.test/apply",
      title: "Application",
      stage: "application_form",
      frameRef: { documentId: nodeRef.documentId, kind: "main" },
      mutationEpoch: nodeRef.observedAt,
      fields: [],
      actions: [],
      errors: []
    } as const;

    expect(FormSnapshotSchema.safeParse({ ...snapshot, boundaries: Array.from({ length: 50 }, () => boundary) }).success).toBe(true);
    expect(FormSnapshotSchema.safeParse({ ...snapshot, boundaries: Array.from({ length: 51 }, () => boundary) }).success).toBe(false);
  });

  it("defines stable runtime transaction error codes", () => {
    for (const code of [
      "control_unstable",
      "controlled_value_reverted",
      "stale_node_ref",
      "node_role_changed",
      "execution_invalidated"
    ]) {
      expect(StableExecutionErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(StableExecutionErrorCodeSchema.safeParse("candidate-secret").success).toBe(false);
  });

  it("binds snapshots and executable commands to observed nodes", () => {
    const parsed = FormSnapshotSchema.parse({
      id: "snapshot-1",
      taskId: "task-1",
      url: "https://example.test/apply",
      title: "申请",
      stage: "application_form",
      frameRef: { documentId: nodeRef.documentId, kind: "main" },
      mutationEpoch: nodeRef.observedAt,
      fields: [{
        id: "field-name",
        label: "姓名",
        type: "text",
        required: true,
        options: [],
        currentValue: "",
        nodeRef
      }],
      actions: [{
        id: "action-next",
        text: "下一步",
        class: "intermediate_navigation",
        nodeRef
      }],
      errors: []
    });

    expect(parsed.fields[0]?.nodeRef).toEqual(nodeRef);
    expect(parsed.actions[0]?.nodeRef).toEqual(nodeRef);
    expect(ExecutableCommandSchema.parse({
      type: "fill",
      taskId: "task-1",
      snapshotId: "snapshot-1",
      fieldId: "field-name",
      nodeRef,
      executionEpoch: 11,
      value: "Ada",
      approval: "token"
    }).nodeRef).toEqual(nodeRef);
  });

  it("accepts only finite field section hints", () => {
    expect(FormFieldSchema.parse({
      id: "company",
      label: "Company",
      type: "text",
      required: false,
      options: [],
      currentValue: "",
      nodeRef,
      sectionHint: "internship"
    }).sectionHint).toBe("internship");

    expect(FormFieldSchema.safeParse({
      id: "company",
      label: "Company",
      type: "text",
      required: false,
      options: [],
      currentValue: "",
      nodeRef,
      sectionHint: "arbitrary-section"
    }).success).toBe(false);
  });

  it("preserves optional action context for site adapters", () => {
    expect(FormSnapshotSchema.parse({
      id: "snapshot-1", taskId: "task-1", url: "https://example.test/apply", title: "申请",
      stage: "application_form",
      frameRef: { documentId: nodeRef.documentId, kind: "main" }, mutationEpoch: nodeRef.observedAt,
      fields: [],
      actions: [{ id: "action-add", text: "添加", class: "unknown_side_effect", context: "项目经历", nodeRef }],
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
      options: [],
      nodeRef
    }).success).toBe(false);
  });

  it("rejects a fill command without value", () => {
    expect(ExecutableCommandSchema.safeParse({
      type: "fill",
      taskId: "task-1",
      snapshotId: "snapshot-1",
      fieldId: "field-name",
      nodeRef,
      executionEpoch: 11,
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
      currentValue: undefined,
      nodeRef
    }).success).toBe(true);
    expect(ExecutableCommandSchema.safeParse({
      type: "fill",
      taskId: "task-1",
      snapshotId: "snapshot-1",
      fieldId: "field-name",
      nodeRef,
      executionEpoch: 11,
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
      nodeRef,
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
      nodeRef,
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
      nodeRef,
      executionEpoch: 11,
      value: "Ada Lovelace",
      approval: "approval-1"
    }).success).toBe(true);
    expect(ExecutableCommandSchema.safeParse({
      type: "click_intermediate",
      taskId: "task-1",
      snapshotId: "snapshot-1",
      actionId: "action-save",
      nodeRef,
      executionEpoch: 11,
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
    expect(WorkerRequestSchema.parse({
      type: "open",
      taskId: "task-1",
      url: "https://jobs.example.test/apply"
    })).toMatchObject({ navigationPolicy: "default" });
    expect(WorkerRequestSchema.parse({
      type: "open",
      taskId: "task-1",
      url: "https://jobs.example.test/apply",
      navigationPolicy: "public_https"
    })).toMatchObject({ navigationPolicy: "public_https" });
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
        frameRef: { documentId: nodeRef.documentId, kind: "main" },
        mutationEpoch: nodeRef.observedAt,
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
      nodeRef,
      executionEpoch: 3,
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
