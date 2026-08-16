import { describe, expect, it } from "vitest";
import {
  ApplicationActivitySchema,
  ApplicationCommandSchema,
  ApplicationContentReviewSchema,
  ApplicationExecutionProgressSchema,
  ApplicationTaskEventSchema,
  ApplicationTaskHistoryResetSchema,
  ApplicationTaskSchema,
  ApplicationTaskStateSchema
} from "./application.js";

const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";

describe("application contracts", () => {
  it("parses the persistent challenge pause and explicit resume command", () => {
    expect(ApplicationTaskStateSchema.parse("awaiting_challenge")).toBe("awaiting_challenge");
    expect(ApplicationCommandSchema.parse({ type: "resume_after_challenge" }))
      .toEqual({ type: "resume_after_challenge" });
  });

  it("projects a sanitized challenge diagnostic on application tasks", () => {
    const challenge = {
      kind: "captcha",
      detectedAt: "2026-08-15T00:00:00.000Z",
      reasonCode: "moka_captcha_accessible_name"
    } as const;

    expect(ApplicationTaskSchema.parse({
      id: taskId,
      applicationUrl: "https://jobs.example.test/apply",
      state: "awaiting_challenge",
      commands: ["cancel", "resume_after_challenge"],
      challenge
    }).challenge).toEqual(challenge);
  });

  it("accepts strict persisted autofill execution progress on tasks and events", () => {
    const progress = {
      currentPhase: "semantic_fill",
      phases: [
        { phase: "waiting_for_form", status: "completed" },
        { phase: "deterministic_fill", status: "completed" },
        { phase: "semantic_fill", status: "running" },
        { phase: "readback_validation", status: "pending" },
        { phase: "final_review", status: "pending" }
      ],
      current: { action: "正在选择：本科专业", fieldId: "major", attempt: 1, maxAttempts: 2 },
      counts: { exact: 5, semantic: 1, user: 2, missing: 1, failed: 0 }
    } as const;

    expect(ApplicationExecutionProgressSchema.parse(progress)).toEqual(progress);
    expect(ApplicationTaskSchema.parse({
      id: taskId,
      applicationUrl: "https://jobs.example.test/apply",
      state: "filling",
      commands: ["cancel"],
      executionProgress: progress
    }).executionProgress).toEqual(progress);
    expect(ApplicationTaskEventSchema.parse({
      id: "73",
      taskId,
      type: "execution_progress_changed",
      createdAt: "2026-08-14T08:00:00.000Z",
      executionProgress: progress
    })).toMatchObject({ type: "execution_progress_changed", executionProgress: progress });
  });

  it("exposes persisted profile synchronization state on application tasks", () => {
    const task = ApplicationTaskSchema.parse({
      id: "734b72a5-bb6b-4946-b5cc-cfe8419bd0eb",
      applicationUrl: "https://jobs.example.test/apply",
      state: "filling",
      commands: ["cancel"],
      profileRevisionApplied: 4,
      profileSyncStatus: "failed",
      profileSyncError: "browser_unavailable"
    });

    expect(task).toMatchObject({
      profileRevisionApplied: 4,
      profileSyncStatus: "failed",
      profileSyncError: "browser_unavailable"
    });
  });

  it("accepts a field coverage report on a task", () => {
    const task = ApplicationTaskSchema.parse({
      id: "734b72a5-bb6b-4946-b5cc-cfe8419bd0eb",
      applicationUrl: "https://apply.careers.dji.com/campus-recruitment/dji/143359#/apply",
      state: "needs_questions",
      commands: ["cancel", "answer_questions"],
      fieldCoverage: {
        total: 2, ready: 0, review: 1, missing: 1, unsupported: 0, filled: 0, failed: 0,
        fields: [{
          fieldId: "field-school", label: "毕业院校", semantic: "education[0].institution",
          status: "missing", source: "none", confidence: 0, reason: "档案中没有可验证的资料", evidence: []
        }]
      }
    });

    expect(task.fieldCoverage?.fields[0]?.status).toBe("missing");
  });
  it("accepts the guarded profile resumption command", () => {
    expect(ApplicationCommandSchema.parse({ type: "resume_with_profile" })).toEqual({ type: "resume_with_profile" });
  });

  it("accepts the task-scoped profile synchronization command", () => {
    expect(ApplicationCommandSchema.parse({ type: "sync_profile" })).toEqual({ type: "sync_profile" });
  });

  it("parses a redacted operation progress event", () => {
    expect(ApplicationTaskEventSchema.parse({
      id: "7",
      taskId,
      type: "operation_started",
      createdAt: "2026-07-28T12:00:00.000Z",
      progress: { current: 5, total: 8, phase: "filling", fieldId: "field-phone", displayCategory: "当前字段" },
      operation: { kind: "fill", status: "running", elapsedMs: 1200, timeoutMs: 15000, errorCode: "TIMEOUT" }
    })).toMatchObject({ type: "operation_started", progress: { current: 5 } });
  });

  it("accepts an optional workbench display phase without breaking old progress events", () => {
    const current = ApplicationTaskEventSchema.parse({
      id: "71",
      taskId,
      type: "operation_started",
      createdAt: "2026-08-03T12:00:00.000Z",
      progress: {
        current: 2,
        total: 5,
        phase: "filling",
        displayPhase: "semantic_fill",
        fieldId: "field-training-mode",
        displayCategory: "教育经历"
      },
      operation: { kind: "select", status: "running", elapsedMs: 0, timeoutMs: 15_000 }
    });
    const legacy = ApplicationTaskEventSchema.safeParse({
      id: "72",
      taskId,
      type: "operation_started",
      createdAt: "2026-08-03T12:00:00.000Z",
      progress: { current: 2, total: 5, phase: "filling", fieldId: "field-training-mode", displayCategory: "教育经历" },
      operation: { kind: "select", status: "running", elapsedMs: 0, timeoutMs: 15_000 }
    });

    if (current.type !== "operation_started") throw new Error("unexpected progress event type");
    expect(current.progress).toMatchObject({ displayPhase: "semantic_fill" });
    expect(legacy.success).toBe(true);
  });

  it("parses only safe display categories for activities", () => {
    expect(ApplicationActivitySchema.parse({
      kind: "user_activity",
      fieldId: "field-phone",
      displayCategory: "当前字段"
    })).toEqual({
      kind: "user_activity",
      fieldId: "field-phone",
      displayCategory: "当前字段"
    });
  });

  it("keeps state changes and history resets compatible", () => {
    expect(ApplicationTaskEventSchema.safeParse({
      id: "8",
      taskId,
      type: "state_changed",
      state: "filling",
      createdAt: "2026-07-28T12:00:00.000Z"
    }).success).toBe(true);
    expect(ApplicationTaskHistoryResetSchema.safeParse({
      type: "history_reset",
      taskId,
      reason: "history_gap",
      requestedLastEventId: "3",
      oldestAvailableId: "4"
    }).success).toBe(true);
  });

  it("rejects arbitrary labels and error codes from progress events", () => {
    expect(ApplicationTaskEventSchema.safeParse({
      id: "9",
      taskId,
      type: "operation_started",
      createdAt: "2026-07-28T12:00:00.000Z",
      progress: { current: 5, total: 8, phase: "filling", fieldId: "field-phone", displayCategory: "当前字段", label: "手机号码" },
      operation: { kind: "fill", status: "running", elapsedMs: 1200, timeoutMs: 15000, errorCode: "TIMEOUT" }
    }).success).toBe(false);
    expect(ApplicationTaskEventSchema.safeParse({
      id: "10",
      taskId,
      type: "operation_started",
      createdAt: "2026-07-28T12:00:00.000Z",
      progress: { current: 5, total: 8, phase: "filling", fieldId: "field-phone", displayCategory: "当前字段" },
      operation: { kind: "fill", status: "running", elapsedMs: 1200, timeoutMs: 15000, errorCode: "任意错误消息" }
    }).success).toBe(false);
  });

  it("returns structured questions that can be answered by stable question ids", () => {
    expect(ApplicationTaskSchema.parse({
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      applicationUrl: "https://jobs.example.test/apply",
      state: "needs_questions",
      commands: ["answer_questions"],
      questions: [{
        id: "question-city",
        fieldId: "field-city",
        fieldPath: "preferences.city",
        label: "期望城市",
        text: "请补充城市",
        pageText: "期望城市",
        interpretation: "系统识别为投递偏好字段",
        missingInformation: "缺少本次投递使用的城市",
        scope: "application",
        inputType: "select",
        options: ["杭州", "深圳"],
        required: true
      }]
    }).questions).toEqual([
      {
        id: "question-city",
        fieldId: "field-city",
        fieldPath: "preferences.city",
        label: "期望城市",
        text: "请补充城市",
        pageText: "期望城市",
        interpretation: "系统识别为投递偏好字段",
        missingInformation: "缺少本次投递使用的城市",
        scope: "application",
        inputType: "select",
        options: ["杭州", "深圳"],
        required: true
      }
    ]);
  });

  it("projects review provenance and task-scoped answers", () => {
    const task = ApplicationTaskSchema.parse({
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      applicationUrl: "https://jobs.example.test/apply",
      state: "awaiting_content_review",
      commands: ["approve_content", "reject_content"],
      questions: [],
      taskAnswers: [{ id: "answer-city", fieldPath: "preferences.city", value: "杭州" }],
      contentReview: {
        id: "review-1",
        fieldId: "self-evaluation",
        fieldLabel: "自我评价",
        original: "原始内容",
        draft: "岗位微调内容",
        reasons: ["突出岗位相关经验"],
        evidence: [{ documentId: "resume", page: 1, text: "项目经验", extraction: "pdf_text" }],
        unsupportedClaims: [],
        status: "needs_review"
      }
    });

    expect(task.contentReview?.original).toBe("原始内容");
    expect(task.taskAnswers[0]?.fieldPath).toBe("preferences.city");
  });

  it("accepts an approved content review without unsupported claims", () => {
    const review = ApplicationContentReviewSchema.parse({
      id: "review-approved",
      fieldId: "self-evaluation",
      draft: "已由用户确认的岗位微调内容",
      unsupportedClaims: [],
      status: "approved"
    });

    expect(review.status).toBe("approved");
  });

  it("projects only finite server-authorized recovery commands", () => {
    const parsed = ApplicationTaskSchema.parse({
      id: taskId,
      applicationUrl: "https://jobs.example.test/apply",
      state: "filling",
      commands: ["cancel"],
      recoveryCommands: ["manual_done"],
      questions: []
    });

    expect(parsed.recoveryCommands).toEqual(["manual_done"]);
    expect(ApplicationTaskSchema.safeParse({
      ...parsed,
      recoveryCommands: ["submit"]
    }).success).toBe(false);
  });

  it("rejects review projections that authorize unsupported claims", () => {
    expect(ApplicationTaskSchema.safeParse({
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      applicationUrl: "https://jobs.example.test/apply",
      state: "awaiting_content_review",
      commands: ["approve_content"],
      questions: [],
      contentReview: {
        id: "review-1",
        fieldId: "self",
        draft: "新增 Rust 经验",
        unsupportedClaims: ["Rust"],
        status: "needs_review"
      }
    }).success).toBe(false);
  });

  it("keeps final submission outside the application command union", () => {
    expect(ApplicationCommandSchema.safeParse({ type: "submit" }).success).toBe(false);
  });

  it("keeps question answers task-scoped unless profile promotion is explicit", () => {
    expect(ApplicationCommandSchema.parse({
      type: "answer_questions",
      answers: [{ id: "available-date", value: "2026-08-15" }]
    })).toEqual({
      type: "answer_questions",
      answers: [{ id: "available-date", value: "2026-08-15", scope: "application", promoteToProfile: false }]
    });
    const promoted = ApplicationCommandSchema.parse({
      type: "answer_questions",
      answers: [{ id: "available-date", value: "2026-08-15", scope: "application", promoteToProfile: true }]
    });
    expect(promoted.type).toBe("answer_questions");
    if (promoted.type !== "answer_questions") throw new Error("unexpected command type");
    expect(promoted.answers[0]).toMatchObject({ promoteToProfile: true });
  });
});
