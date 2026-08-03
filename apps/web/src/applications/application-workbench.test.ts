import type { ApplicationTask, ApplicationTaskProgressEvent } from "@resume/contracts";
import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  deriveAttentionItems,
  deriveDisplayPhase,
  recentActivities,
  type AttentionItem
} from "./application-workbench.js";
import { CompactActivityFeed } from "./CompactActivityFeed.js";
import { LiveBrowserStatus } from "./LiveBrowserStatus.js";
import { TaskAttentionList } from "./TaskAttentionList.js";
import { TaskStageStepper } from "./TaskStageStepper.js";

const task: ApplicationTask = {
  id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
  applicationUrl: "https://career.example.com/jobs/42",
  state: "filling",
  commands: ["cancel"],
  recoveryCommands: [],
  questions: [],
  taskAnswers: []
};

function operation(
  id: string,
  type: "operation_started" | "operation_completed",
  displayPhase?: "deterministic_fill" | "semantic_fill" | "dynamic_validation"
): ApplicationTaskProgressEvent {
  return {
    id,
    taskId: task.id,
    type,
    createdAt: `2026-08-03T12:00:${id.padStart(2, "0")}.000Z`,
    progress: {
      current: 2,
      total: 5,
      phase: "filling",
      ...(displayPhase === undefined ? {} : { displayPhase }),
      fieldId: `field-${id}`,
      displayCategory: "教育经历"
    },
    operation: {
      kind: "fill",
      status: type === "operation_started" ? "running" : "succeeded",
      elapsedMs: 200,
      timeoutMs: 15_000
    }
  };
}

describe("投递工作台纯逻辑", () => {
  it("优先使用服务端显示阶段，并兼容没有新字段的旧事件", () => {
    expect(deriveDisplayPhase(task, [operation("1", "operation_started", "semantic_fill")])).toBe("semantic_fill");
    expect(deriveDisplayPhase(task, [operation("2", "operation_started")])).toBe("deterministic_fill");
    expect(deriveDisplayPhase({ ...task, state: "validating" }, [])).toBe("dynamic_validation");
    expect(deriveDisplayPhase({ ...task, state: "review_locked" }, [])).toBe("review_handoff");
  });

  it("把追问、内容审核和暂停聚合为按风险排序的人工处理项", () => {
    const questionTask: ApplicationTask = {
      ...task,
      state: "needs_questions",
      questions: [{
        id: "question-city",
        fieldId: "field-city",
        fieldPath: "preferences.city",
        label: "期望城市",
        text: "请补充期望城市",
        pageText: "期望城市",
        interpretation: "系统识别为求职偏好",
        missingInformation: "缺少本次投递城市",
        scope: "application",
        inputType: "text",
        options: [],
        required: true
      }],
      contentReview: {
        id: "review-1",
        fieldId: "self",
        fieldLabel: "自我评价",
        original: "原文",
        draft: "岗位稿",
        reasons: ["需要确认"],
        evidence: [],
        unsupportedClaims: [],
        status: "needs_review"
      },
      recoveryCommands: ["manual_done"]
    };

    const items = deriveAttentionItems(questionTask, [
      { id: "10", taskId: task.id, type: "task_paused", createdAt: "2026-08-03T12:00:10.000Z", activity: { kind: "user_activity", displayCategory: "当前字段" } }
    ]);

    expect(items.map((item) => item.kind)).toEqual(["content_review", "question", "paused"]);
    expect(items[0]?.severity).toBe("high");
  });

  it("默认只保留最近三条活动，并按最新在前展示", () => {
    const activities = ["1", "2", "3", "4"].map((id) => operation(id, "operation_completed"));
    expect(recentActivities(activities)).toEqual([activities[3], activities[2], activities[1]]);
  });
});

describe("投递工作台组件", () => {
  it("renders four stages and marks the current stage", () => {
    render(createElement(TaskStageStepper, { phase: "semantic_fill", counts: { completed: 3, attention: 1 } }));

    expect(screen.getAllByRole("listitem", { name: /阶段/ })).toHaveLength(4);
    expect(screen.getByRole("listitem", { name: "语义补全阶段" })).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("3 项已完成")).toBeVisible();
  });

  it("renders the live browser state from the real connection and activity projection", () => {
    render(createElement(LiveBrowserStatus, {
      connection: "connected",
      taskState: "filling",
      activities: [{
        id: "2",
        taskId: task.id,
        type: "browser_activity",
        createdAt: "2026-08-03T12:00:02.000Z",
        activity: { kind: "user_activity", displayCategory: "当前字段" }
      }]}
    ));

    expect(screen.getByRole("status")).toHaveTextContent("用户操作中");
    expect(screen.getByText("自动填写已暂停")).toBeVisible();
  });

  it("renders attention items as selectable work controls", async () => {
    const items: AttentionItem[] = [{
      id: "question-city",
      kind: "question",
      label: "期望城市",
      summary: "等待补充信息",
      severity: "high"
    }];
    const onSelect = vi.fn();
    render(createElement(TaskAttentionList, { items, selectedId: items[0]!.id, onSelect }));

    expect(screen.getByRole("heading", { name: "需要你处理" })).toBeVisible();
    expect(screen.getByRole("button", { name: /期望城市/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /^(?:提交(?:申请|简历)?|投递(?:申请|简历)?|发送(?:申请|简历)?|确认(?:申请|投递)|完成申请|立即申请)$/ })).not.toBeInTheDocument();
  });

  it("keeps the activity detail collapsed by default", () => {
    render(createElement(CompactActivityFeed, { activities: [operation("1", "operation_completed")] }));

    const details = screen.getByText("最近活动").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(within(details!).getByText("教育经历处理成功")).toBeInTheDocument();
  });
});
