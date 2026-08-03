import type { ApplicationTask } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApplicationReviewInbox } from "./ApplicationReviewInbox.js";

function task(id: string, state: ApplicationTask["state"], suffix: string): ApplicationTask {
  return {
    id: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
    applicationUrl: `https://career.example.com/jobs/${suffix}`,
    state,
    commands: [],
    recoveryCommands: [],
    questions: [],
    taskAnswers: []
  };
}

describe("ApplicationReviewInbox", () => {
  it("lists only tasks that need a user decision", async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn();
    const reviewLockedTask = task("1", "review_locked", "review");
    const fillingTask = task("2", "filling", "filling");
    const questionTask = task("3", "needs_questions", "questions");
    render(<ApplicationReviewInbox tasks={[reviewLockedTask, fillingTask, questionTask]} onOpenTask={onOpenTask} />);

    expect(screen.getByText(reviewLockedTask.applicationUrl)).toBeVisible();
    expect(screen.getByText(questionTask.applicationUrl)).toBeVisible();
    expect(screen.queryByText(fillingTask.applicationUrl)).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "进入任务" })[0]!);
    expect(onOpenTask).toHaveBeenCalledWith(expect.stringContaining("00000000-0000-4000-8000-"));
    expect(screen.queryByRole("button", { name: /提交/ })).not.toBeInTheDocument();
  });
});
