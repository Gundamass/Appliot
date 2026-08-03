import type { ApplicationTask, ApplicationTaskProgressEvent } from "@resume/contracts";
import { act, render, screen, within } from "@testing-library/react";
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
  it("shows the concise three-layer summary while keeping activity details collapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:02.000Z"));
    const activities: ApplicationTaskProgressEvent[] = [
      progressEvent("1", "operation_completed", "succeeded", 4, "个人信息"),
      progressEvent("2", "operation_started", "running", 5),
      ...Array.from({ length: 6 }, (_, index): ApplicationTaskProgressEvent => ({
        id: String(index + 3),
        taskId: task.id,
        type: "browser_activity",
        createdAt: `2026-07-28T08:00:${index + 10}.000Z`,
        activity: { kind: "page_stable", displayCategory: "页面状态" }
      }))
    ];

    try {
      render(<ProgressSummary task={task} activities={activities} />);

      expect(screen.getByRole("heading", { name: "正在填写联系方式" })).toBeVisible();
      expect(screen.getByText("第 5 / 8 项")).toBeVisible();
      expect(screen.getByText("已用时 1.2 秒")).toBeVisible();
      expect(screen.getByText("上一项：个人信息已填写并验证成功")).toBeVisible();
      expect(screen.getAllByRole("listitem", { name: /阶段/ })).toHaveLength(5);

      const details = screen.getByText("执行历史").closest("details");
      expect(details).not.toHaveAttribute("open");
      for (const item of within(details!).getAllByText("页面已稳定")) expect(item).not.toBeVisible();
      expect(within(details!).getAllByRole("listitem")).toHaveLength(5);
      expect(within(details!).queryByRole("button")).not.toBeInTheDocument();
      expect(within(details!).queryByRole("link")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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

  it("clears the running action after the operation completes", () => {
    const activities: ApplicationTaskProgressEvent[] = [
      progressEvent("1", "operation_started", "running", 5),
      progressEvent("2", "operation_completed", "succeeded", 5)
    ];

    render(<ProgressSummary task={task} activities={activities} />);

    expect(screen.queryByRole("heading", { name: "正在填写联系方式" })).not.toBeInTheDocument();
    expect(screen.queryByText("第 5 / 8 项")).not.toBeInTheDocument();
    expect(screen.getByText("上一项：联系方式已填写并验证成功")).toBeVisible();
  });

  it("does not revive an interrupted operation after the task resumes", () => {
    const activities: ApplicationTaskProgressEvent[] = [
      progressEvent("1", "operation_started", "running", 5),
      {
        id: "2", taskId: task.id, type: "task_paused", createdAt: "2026-07-28T08:00:02.000Z",
        activity: { kind: "user_activity", fieldId: "field-1", displayCategory: "联系方式" }
      },
      {
        id: "3", taskId: task.id, type: "task_resumed", createdAt: "2026-07-28T08:00:03.000Z",
        activity: { kind: "page_stable", fieldId: "field-1", displayCategory: "页面状态" }
      }
    ];

    render(<ProgressSummary task={task} activities={activities} />);

    expect(screen.queryByRole("heading", { name: "正在填写联系方式" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "正在填写" })).toBeVisible();
  });

  it("updates elapsed time while an operation remains active", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:01.000Z"));
    const running = progressEvent("1", "operation_started", "running", 5);
    running.createdAt = "2026-07-28T08:00:01.000Z";

    render(<ProgressSummary task={task} activities={[running]} />);
    expect(screen.getByText("已用时 1.2 秒")).toBeVisible();

    act(() => vi.advanceTimersByTime(1_000));

    expect(screen.getByText("已用时 2.2 秒")).toBeVisible();
    vi.useRealTimers();
  });

  it("starts elapsed time from the reported value when an operation begins after idle time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:00:01.000Z"));
    const { rerender } = render(<ProgressSummary task={task} activities={[]} />);

    act(() => vi.advanceTimersByTime(5 * 60_000));
    const running = progressEvent("1", "operation_started", "running", 5);
    running.createdAt = "2026-07-28T08:05:01.000Z";
    rerender(<ProgressSummary task={task} activities={[running]} />);

    expect(screen.getByText("已用时 1.2 秒")).toBeVisible();
    vi.useRealTimers();
  });
});
