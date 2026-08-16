import type { ApplicationTask, ApplicationTaskProgressEvent } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProgressSummary } from "./ApplicationTaskPage.js";

const task: ApplicationTask = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  applicationUrl: "https://career.example.com/jobs/42",
  state: "filling",
  commands: ["cancel"],
  recoveryCommands: [],
  questions: [],
  taskAnswers: []
};

const progressTask: ApplicationTask = {
  ...task,
  executionProgress: {
    currentPhase: "semantic_fill",
    phases: [
      { phase: "waiting_for_form", status: "completed" },
      { phase: "deterministic_fill", status: "completed" },
      { phase: "semantic_fill", status: "running" },
      { phase: "readback_validation", status: "pending" },
      { phase: "final_review", status: "pending" }
    ],
    current: { action: "正在选择：本科专业", fieldId: "major", attempt: 1, maxAttempts: 2 },
    counts: { exact: 12, semantic: 3, user: 4, missing: 2, failed: 1 }
  }
};

function progressEvent(
  id: string,
  type: "operation_started" | "operation_completed" | "operation_failed",
  status: "running" | "succeeded" | "timed_out",
  current: number,
  displayCategory: "联系方式" | "个人信息" = "联系方式"
): ApplicationTaskProgressEvent {
  return {
    id,
    taskId: task.id,
    type,
    createdAt: `2026-07-28T08:00:0${id}.000Z`,
    progress: { current, total: 8, phase: "filling", fieldId: `field-${id}`, displayCategory },
    operation: {
      kind: "fill",
      status,
      elapsedMs: status === "running" ? 1_200 : 850,
      timeoutMs: 15_000,
      ...(status === "timed_out" ? { errorCode: "TIMEOUT" as const } : {})
    }
  };
}

describe("ProgressSummary", () => {
  it("shows only backend-owned phase, current action, attempt and five counts", () => {
    render(<ProgressSummary
      task={progressTask}
      activities={[progressEvent("1", "operation_started", "running", 5)]}
    />);

    expect(screen.getByText("当前：语义补全")).toBeVisible();
    expect(screen.getByRole("heading", { name: "正在选择：本科专业" })).toBeVisible();
    expect(screen.getByText("尝试 1/2")).toBeVisible();
    expect(screen.getByLabelText("填写统计")).toHaveTextContent("精确 12语义 3用户已有 4未匹配 2失败 1");
    expect(screen.queryByRole("heading", { name: "正在填写联系方式" })).not.toBeInTheDocument();
  });

  it("shows only server-authorized recovery actions for a paused field", async () => {
    const user = userEvent.setup();
    const onRecovery = vi.fn();
    const activities: ApplicationTaskProgressEvent[] = [
      progressEvent("1", "operation_failed", "timed_out", 5),
      {
        id: "2",
        taskId: task.id,
        type: "task_paused",
        createdAt: "2026-07-28T08:00:02.000Z",
        activity: { kind: "user_activity", fieldId: "field-1", displayCategory: "联系方式" }
      }
    ];

    render(<ProgressSummary task={{ ...task, recoveryCommands: ["retry_current", "manual_done", "cancel"] } as ApplicationTask} activities={activities} onRecovery={onRecovery} />);

    expect(screen.getByRole("heading", { name: "联系方式填写超时" })).toBeVisible();
    expect(screen.getByText("系统已暂停自动填写，避免继续覆盖页面内容。")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重试当前项" }));
    await user.click(screen.getByRole("button", { name: "我已手动完成" }));
    await user.click(screen.getByRole("button", { name: "取消任务" }));

    expect(onRecovery).toHaveBeenNthCalledWith(1, "retry_current");
    expect(onRecovery).toHaveBeenNthCalledWith(2, "manual_done");
    expect(onRecovery).toHaveBeenNthCalledWith(3, "cancel");
    expect(screen.queryByRole("button", { name: /^(?:提交(?:申请|简历)?|投递(?:申请|简历)?|发送(?:申请|简历)?|确认(?:申请|投递)|完成申请|立即申请)$/ })).not.toBeInTheDocument();
  });

  it("projects a user-activity pause without requiring an operation failure", () => {
    const pausedTask: ApplicationTask = {
      ...task,
      recoveryCommands: ["manual_done"]
    };
    const activities: ApplicationTaskProgressEvent[] = [
      progressEvent("1", "operation_started", "running", 5),
      {
        id: "2",
        taskId: task.id,
        type: "task_paused",
        createdAt: "2026-07-28T08:00:02.000Z",
        activity: { kind: "user_activity", fieldId: "field-1", displayCategory: "联系方式" }
      }
    ];

    render(<ProgressSummary task={pausedTask} activities={activities} />);

    expect(screen.getByRole("heading", { name: "已暂停自动填写" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "正在填写联系方式" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "我已手动完成" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "重试当前项" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消任务" })).not.toBeInTheDocument();
  });

});
