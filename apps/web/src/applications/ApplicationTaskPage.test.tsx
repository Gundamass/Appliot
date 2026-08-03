import type { ApplicationTask, ApplicationTaskEvent, ApplicationTaskProgressEvent } from "@resume/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApplicationTaskPage } from "./ApplicationTaskPage.js";
import type { TaskEventConnection } from "./useTaskEvents.js";

const task: ApplicationTask = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  applicationUrl: "https://career.example.com/jobs/42",
  state: "waiting_for_login",
  commands: ["cancel", "open_browser", "resume"],
  recoveryCommands: [],
  questions: [],
  taskAnswers: []
};

const submissionActionName = /^(?:提交(?:申请|简历)?|投递(?:申请|简历)?|发送(?:申请|简历)?|确认(?:申请|投递)|完成申请|立即申请)$/;

function event(state: ApplicationTaskEvent["state"], id = "2"): ApplicationTaskEvent {
  return {
    id,
    taskId: task.id,
    type: "state_changed",
    state,
    createdAt: "2026-07-28T08:00:00.000Z"
  };
}

function eventHarness() {
  let handlers: Parameters<TaskEventConnection>[1] | undefined;
  const connect: TaskEventConnection = (_taskId, nextHandlers) => {
    handlers = nextHandlers;
    nextHandlers.onOpen();
    return () => undefined;
  };
  return {
    connect,
    emit: (next: ApplicationTaskProgressEvent) => handlers?.onEvent(next),
    snapshot: () => handlers,
    reset: () => handlers?.onHistoryReset({
      type: "history_reset",
      taskId: task.id,
      reason: "history_gap",
      requestedLastEventId: "1",
      oldestAvailableId: "8"
    }),
    disconnect: () => handlers?.onDisconnect()
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("ApplicationTaskPage", () => {
  it("renders the workbench structure with four stages, browser status, attention, and compact activity", async () => {
    const events = eventHarness();
    render(<ApplicationTaskPage taskId={task.id} api={{ get: vi.fn().mockResolvedValue(task), command: vi.fn() }} connectEvents={events.connect} />);

    expect(await screen.findByRole("heading", { name: "投递任务工作台" })).toBeVisible();
    expect(screen.getAllByRole("listitem", { name: /阶段/ })).toHaveLength(4);
    expect(screen.getByRole("status", { name: "受控浏览器状态" })).toHaveTextContent("受控浏览器已连接");
    expect(screen.getByRole("heading", { name: "需要你处理" })).toBeVisible();
    expect(screen.getByText("最近活动").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByRole("button", { name: submissionActionName })).not.toBeInTheDocument();
  });

  it("shows manual login and advances from task events without exposing submission", async () => {
    const events = eventHarness();
    const get = vi.fn().mockResolvedValue(task);
    render(<ApplicationTaskPage taskId={task.id} api={{ get, command: vi.fn() }} connectEvents={events.connect} />);

    expect(await screen.findByText("请在受控浏览器中完成登录")).toBeVisible();
    events.emit(event("observing_page"));

    expect(await screen.findByText("正在分析投递页面")).toBeVisible();
    expect(screen.queryByRole("button", { name: submissionActionName })).not.toBeInTheDocument();
  });

  it("keeps the last known state visible while the event stream reconnects", async () => {
    const events = eventHarness();
    render(<ApplicationTaskPage taskId={task.id} api={{ get: vi.fn().mockResolvedValue(task), command: vi.fn() }} connectEvents={events.connect} />);

    expect(await screen.findByText("请在受控浏览器中完成登录")).toBeVisible();
    events.disconnect();

    expect(await screen.findByText("实时连接已中断，正在恢复")).toBeVisible();
    expect(await screen.findByText("上次状态：等待登录")).toBeVisible();
  });

  it("executes only commands exposed by the current task", async () => {
    const user = userEvent.setup();
    const events = eventHarness();
    const command = vi.fn().mockResolvedValue({ ...task, state: "observing_page", commands: ["cancel"] });
    render(<ApplicationTaskPage taskId={task.id} api={{ get: vi.fn().mockResolvedValue(task), command }} connectEvents={events.connect} />);

    await user.click(await screen.findByRole("button", { name: "我已完成登录，继续" }));

    expect(command).toHaveBeenCalledWith(task.id, { type: "resume" });
    expect(await screen.findByRole("heading", { name: "正在分析投递页面" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "我已完成登录，继续" })).not.toBeInTheDocument();
  });

  it("retries unresolved fields from the updated profile only when authorized", async () => {
    const user = userEvent.setup();
    const events = eventHarness();
    const waitingTask: ApplicationTask = {
      ...task,
      state: "needs_questions",
      commands: ["cancel", "open_browser", "answer_questions", "resume_with_profile"]
    };
    const command = vi.fn().mockResolvedValue({ ...waitingTask, state: "observing_page", commands: ["cancel"] });
    render(<ApplicationTaskPage taskId={task.id} api={{ get: vi.fn().mockResolvedValue(waitingTask), command }} connectEvents={events.connect} />);

    await user.click(await screen.findByRole("button", { name: "我已补全档案，重新匹配" }));

    expect(command).toHaveBeenCalledWith(task.id, { type: "resume_with_profile" });
    expect(screen.queryByRole("button", { name: submissionActionName })).not.toBeInTheDocument();
  });

  it("uses the server projection after events instead of inventing commands", async () => {
    const events = eventHarness();
    const get = vi.fn().mockResolvedValueOnce(task).mockResolvedValueOnce({ ...task, state: "needs_questions", commands: [] });
    render(<ApplicationTaskPage taskId={task.id} api={{ get, command: vi.fn() }} connectEvents={events.connect} />);

    expect(await screen.findByRole("button", { name: "我已完成登录，继续" })).toBeVisible();
    events.emit(event("needs_questions"));

    expect(await screen.findByRole("heading", { name: "等待补充信息" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "我已完成登录，继续" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开受控浏览器" })).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not let an older refresh overwrite review_locked", async () => {
    const events = eventHarness();
    const stale = deferred<ApplicationTask>();
    const get = vi.fn()
      .mockResolvedValueOnce(task)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ ...task, state: "review_locked", commands: [] });
    render(<ApplicationTaskPage taskId={task.id} api={{ get, command: vi.fn() }} connectEvents={events.connect} />);
    expect(await screen.findByText("请在受控浏览器中完成登录")).toBeVisible();

    events.reset();
    events.emit(event("review_locked", "9"));
    expect(await screen.findByRole("heading", { name: "等待人工最终审核" })).toBeVisible();
    stale.resolve(task);

    expect(await screen.findByRole("heading", { name: "等待人工最终审核" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "我已完成登录，继续" })).not.toBeInTheDocument();
  });

  it("does not let an older command response overwrite review_locked", async () => {
    const user = userEvent.setup();
    const events = eventHarness();
    const commandResponse = deferred<ApplicationTask>();
    const get = vi.fn().mockResolvedValueOnce(task).mockResolvedValueOnce({ ...task, state: "review_locked", commands: [] });
    render(<ApplicationTaskPage taskId={task.id} api={{ get, command: vi.fn(() => commandResponse.promise) }} connectEvents={events.connect} />);
    await user.click(await screen.findByRole("button", { name: "我已完成登录，继续" }));

    events.emit(event("review_locked", "9"));
    expect(await screen.findByRole("heading", { name: "等待人工最终审核" })).toBeVisible();
    commandResponse.resolve({ ...task, state: "observing_page", commands: ["cancel", "open_browser"] });

    expect(await screen.findByRole("heading", { name: "等待人工最终审核" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "打开受控浏览器" })).not.toBeInTheDocument();
  });

  it("ignores an old task response after the route switches tasks", async () => {
    const events = eventHarness();
    const oldTask = deferred<ApplicationTask>();
    const newTask = deferred<ApplicationTask>();
    const secondId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const secondTask = { ...task, id: secondId, applicationUrl: "https://jobs.example.net/role", state: "observing_page" as const, commands: ["cancel"] as ApplicationTask["commands"] };
    const get = vi.fn((id: string) => id === task.id ? oldTask.promise : newTask.promise);
    const { rerender } = render(<ApplicationTaskPage taskId={task.id} api={{ get, command: vi.fn() }} connectEvents={events.connect} />);
    const oldSubscription = events.snapshot();

    rerender(<ApplicationTaskPage taskId={secondId} api={{ get, command: vi.fn() }} connectEvents={events.connect} />);
    oldSubscription?.onEvent(event("review_locked", "9"));
    oldSubscription?.onHistoryReset({ type: "history_reset", taskId: task.id, reason: "history_gap", requestedLastEventId: "1", oldestAvailableId: "8" });
    newTask.resolve(secondTask);
    expect(await screen.findByRole("heading", { name: "正在分析投递页面" })).toBeVisible();
    oldTask.resolve(task);

    expect(await screen.findByText("jobs.example.net")).toBeVisible();
    expect(screen.queryByText("career.example.com")).not.toBeInTheDocument();
  });

  it("cancels through the typed command and removes all task controls", async () => {
    const user = userEvent.setup();
    const events = eventHarness();
    const command = vi.fn().mockResolvedValue({ ...task, state: "cancelled", commands: [] });
    render(<ApplicationTaskPage taskId={task.id} api={{ get: vi.fn().mockResolvedValue(task), command }} connectEvents={events.connect} />);

    await user.click(await screen.findByRole("button", { name: "取消任务" }));

    expect(command).toHaveBeenCalledWith(task.id, { type: "cancel" });
    expect(await screen.findByRole("heading", { name: "任务已取消" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "当前可用操作" })).not.toBeInTheDocument();
  });

  it("submits all page questions together and promotes only explicitly selected answers", async () => {
    const user = userEvent.setup();
    const events = eventHarness();
    const questionTask: ApplicationTask = {
      ...task,
      state: "needs_questions",
      commands: ["cancel", "open_browser", "answer_questions"],
      questions: [{
        id: "available-date",
        fieldId: "available-date",
        fieldPath: "preferences.availableDate",
        label: "可入职时间",
        text: "请确认可入职时间",
        pageText: "可入职时间",
        interpretation: "系统识别为到岗日期",
        missingInformation: "缺少本次投递的可入职日期",
        scope: "application",
        inputType: "date",
        options: [],
        required: true
      }]
    };
    const command = vi.fn().mockResolvedValue({ ...questionTask, state: "filling", commands: ["cancel"], questions: [] });
    render(<ApplicationTaskPage taskId={task.id} api={{ get: vi.fn().mockResolvedValue(questionTask), command }} connectEvents={events.connect} />);

    await user.type(await screen.findByLabelText("可入职时间"), "2026-08-15");
    await user.click(screen.getByRole("checkbox", { name: "将“可入职时间”保存为长期资料" }));
    await user.click(screen.getByRole("button", { name: "继续填写" }));

    expect(command).toHaveBeenCalledWith(task.id, {
      type: "answer_questions",
      answers: [{ id: "available-date", value: "2026-08-15", scope: "application", promoteToProfile: true }]
    });
  });

  it("clears the question busy state when an SSE refresh supersedes the command response", async () => {
    const user = userEvent.setup();
    const events = eventHarness();
    const commandResponse = deferred<ApplicationTask>();
    const questionTask: ApplicationTask = {
      ...task,
      state: "needs_questions",
      commands: ["answer_questions"],
      questions: [{
        id: "email",
        fieldId: "email",
        label: "邮箱",
        text: "请输入邮箱",
        pageText: "邮箱",
        interpretation: "系统识别为邮箱",
        missingInformation: "缺少本次投递邮箱",
        scope: "application",
        inputType: "text",
        options: [],
        required: true
      }]
    };
    const get = vi.fn().mockResolvedValue(questionTask);
    render(<ApplicationTaskPage taskId={task.id} api={{ get, command: vi.fn(() => commandResponse.promise) }} connectEvents={events.connect} />);

    await user.type(await screen.findByLabelText("邮箱"), "candidate@example.com");
    await user.click(screen.getByRole("button", { name: "继续填写" }));
    expect(screen.getByRole("button", { name: "处理中" })).toBeDisabled();

    events.emit(event("needs_questions", "9"));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    commandResponse.resolve(questionTask);

    expect(await screen.findByRole("button", { name: "继续填写" })).toBeEnabled();
  });

  it("renders content review and sends only explicit review commands", async () => {
    const user = userEvent.setup();
    const events = eventHarness();
    const reviewTask: ApplicationTask = {
      ...task,
      state: "awaiting_content_review",
      commands: ["cancel", "open_browser", "approve_content", "reject_content"],
      contentReview: {
        id: "review-1",
        fieldId: "self",
        fieldLabel: "自我评价",
        original: "原始自我评价",
        draft: "岗位微调稿",
        reasons: ["突出相关经验"],
        evidence: [],
        unsupportedClaims: [],
        status: "needs_review"
      }
    };
    const command = vi.fn().mockResolvedValue({ ...reviewTask, state: "filling", commands: ["cancel"], contentReview: undefined });
    render(<ApplicationTaskPage taskId={task.id} api={{ get: vi.fn().mockResolvedValue(reviewTask), command }} connectEvents={events.connect} />);

    expect(await screen.findByRole("heading", { name: "审核自我评价" })).toBeVisible();
    expect(command).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("最终填写内容"));
    await user.type(screen.getByLabelText("最终填写内容"), "用户确认稿");
    await user.click(screen.getByRole("button", { name: "采用最终稿" }));

    expect(command).toHaveBeenCalledWith(task.id, { type: "approve_content", reviewId: "review-1", editedValue: "用户确认稿" });
  });

  it("isolates old progress events after switching tasks", async () => {
    const events = eventHarness();
    const secondId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const get = vi.fn().mockImplementation((id: string) => Promise.resolve({
      ...task,
      id,
      state: "filling",
      commands: ["cancel"]
    }));
    const { rerender } = render(<ApplicationTaskPage taskId={task.id} api={{ get, command: vi.fn() }} connectEvents={events.connect} />);
    await screen.findByText("career.example.com");
    const oldSubscription = events.snapshot();

    rerender(<ApplicationTaskPage taskId={secondId} api={{ get, command: vi.fn() }} connectEvents={events.connect} />);
    oldSubscription?.onEvent({
      id: "20", taskId: task.id, type: "operation_started", createdAt: "2026-07-28T08:00:00.000Z",
      progress: { current: 7, total: 8, phase: "filling", fieldId: "old", displayCategory: "项目经历" },
      operation: { kind: "fill", status: "running", elapsedMs: 500, timeoutMs: 15_000 }
    });

    await waitFor(() => expect(get).toHaveBeenCalledWith(secondId));
    expect(screen.queryByText("正在填写项目经历")).not.toBeInTheDocument();
  });
});
