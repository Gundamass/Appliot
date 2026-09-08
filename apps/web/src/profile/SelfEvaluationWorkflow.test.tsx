import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProfileApi, SelfEvaluationReviewApi } from "../api/client.js";
import { ProfilePage } from "./ProfilePage.js";

const review = {
  taskId: "task-new",
  jobDescription: "React platform role",
  original: "Original summary",
  draft: "Tailored summary",
  reasons: ["Role emphasis"],
  evidence: [],
  unsupportedClaims: [],
  status: "needs_review" as const,
  base: {
    factId: "self",
    revision: 1,
    original: "Original summary",
    evidence: [{ documentId: "resume", page: 1, text: "Original summary", extraction: "pdf_text" as const }]
  }
};

describe("self-evaluation workflow", () => {
  it("creates from job provenance and promotes only after explicit approval", async () => {
    const profileApi: ProfileApi = {
      upload: vi.fn(),
      updateCurrentDocument: vi.fn(),
      parseCurrentDocument: vi.fn(),
      getCurrentDocument: vi.fn(async () => undefined),
      uploadAvatar: vi.fn(),
      listFacts: vi.fn(async () => []),
      upsert: vi.fn(),
      remove: vi.fn(async () => undefined),
      getCompleteness: vi.fn(async () => ({ completed: 0, total: 1, sections: [] })),
      getLatestDocument: vi.fn(async () => undefined),
      confirm: vi.fn(),
      correct: vi.fn()
    };
    const reviewApi: SelfEvaluationReviewApi = {
      create: vi.fn(async () => review),
      get: vi.fn(async () => review),
      approve: vi.fn(async () => ({ ...review, status: "approved" as const })),
      promote: vi.fn(async () => ({ ...review, status: "approved" as const }))
    };
    const user = userEvent.setup();
    render(<ProfilePage api={profileApi} reviewApi={reviewApi} />);

    const viewButtons = screen.getByRole("navigation").querySelectorAll("button");
    await user.click(viewButtons[1]!);
    const taskInput = screen.getByLabelText("任务 ID");
    await user.clear(taskInput);
    await user.type(taskInput, "task-new");
    await user.type(screen.getByLabelText("岗位描述"), "React platform role");
    await user.click(screen.getByRole("button", { name: "创建审核" }));

    expect(reviewApi.create).toHaveBeenCalledWith("task-new", "React platform role");
    expect(await screen.findByText("Tailored summary")).toBeVisible();
    expect(reviewApi.approve).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "采用此版本" }));
    expect(await screen.findByRole("button", { name: "推广到长期资料" })).toBeVisible();
    expect(reviewApi.promote).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "推广到长期资料" }));
    expect(reviewApi.promote).toHaveBeenCalledWith("task-new");
  });
});
