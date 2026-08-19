import type { ApplicationTask } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationReviewInbox } from "./ApplicationReviewInbox.js";

function task(id: string, state: ApplicationTask["state"], suffix: string, name?: string): ApplicationTask {
  return {
    id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
    name,
    applicationUrl: `https://career.example.com/jobs/${suffix}`,
    state,
    commands: [],
    recoveryCommands: [],
    questions: [],
    taskAnswers: []
  };
}

describe("ApplicationReviewInbox", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists only tasks that need a user decision", async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn();
    const reviewLockedTask = task("1", "review_locked", "review");
    const fillingTask = task("2", "filling", "filling");
    const questionTask = task("3", "needs_questions", "questions");
    render(<ApplicationReviewInbox tasks={[reviewLockedTask, fillingTask, questionTask]} onOpenTask={onOpenTask} onDeleteTask={vi.fn()} />);

    expect(screen.getByText(reviewLockedTask.applicationUrl)).toBeVisible();
    expect(screen.getByText(questionTask.applicationUrl)).toBeVisible();
    expect(screen.queryByText(fillingTask.applicationUrl)).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "进入任务" })[0]!);
    expect(onOpenTask).toHaveBeenCalledWith(expect.stringContaining("00000000-0000-4000-8000-"));
    expect(screen.queryByRole("button", { name: /提交/ })).not.toBeInTheDocument();
  });

  it("lists ATS adapter certification tasks for human review", () => {
    const candidate = task("4", "awaiting_adapter_review", "adapter-review");
    render(<ApplicationReviewInbox tasks={[candidate]} onOpenTask={vi.fn()} onDeleteTask={vi.fn()} />);

    expect(screen.getByText(candidate.applicationUrl)).toBeVisible();
    expect(screen.getByText("等待 ATS 适配认证")).toBeVisible();
    expect(screen.getByText("认证前不会向真实页面写入字段或执行提交。")).toBeVisible();
  });

  it("uses the persisted name as the card heading and falls back to the host for historical tasks", () => {
    const namedTask = task("1", "needs_questions", "questions", "大疆 Java 后端实习");
    const historicalTask = task("2", "review_locked", "review");
    render(<ApplicationReviewInbox tasks={[namedTask, historicalTask]} onOpenTask={vi.fn()} onDeleteTask={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "大疆 Java 后端实习" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "career.example.com" })).toBeVisible();
  });

  it("shows a delete action on every review task", () => {
    render(<ApplicationReviewInbox tasks={[task("1", "needs_questions", "questions")]} onOpenTask={vi.fn()} onDeleteTask={vi.fn()} />);
    expect(screen.getByRole("button", { name: "删除任务：career.example.com" })).toBeVisible();
  });

  it("does not delete when the user cancels confirmation", async () => {
    const user = userEvent.setup();
    const onDeleteTask = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ApplicationReviewInbox tasks={[task("1", "failed", "failed")]} onOpenTask={vi.fn()} onDeleteTask={onDeleteTask} />);

    await user.click(screen.getByRole("button", { name: "删除任务：career.example.com" }));

    expect(onDeleteTask).not.toHaveBeenCalled();
  });

  it("passes the confirmed task to the delete callback", async () => {
    const user = userEvent.setup();
    const onDeleteTask = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const candidate = task("1", "needs_questions", "questions");
    render(<ApplicationReviewInbox tasks={[candidate]} onOpenTask={vi.fn()} onDeleteTask={onDeleteTask} />);

    await user.click(screen.getByRole("button", { name: "删除任务：career.example.com" }));

    expect(onDeleteTask).toHaveBeenCalledWith(candidate);
  });

  it("includes the displayed name in the delete confirmation", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const candidate = task("1", "needs_questions", "questions", "大疆 Java 后端实习");
    render(<ApplicationReviewInbox tasks={[candidate]} onOpenTask={vi.fn()} onDeleteTask={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "删除任务：大疆 Java 后端实习" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("大疆 Java 后端实习"));
  });
});
