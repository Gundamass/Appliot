import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SelfEvaluationReview as SelfEvaluationReviewModel } from "@resume/contracts";
import { SelfEvaluationReview } from "./SelfEvaluationReview.js";

const reviewableDraft: SelfEvaluationReviewModel = {
  taskId: "task-1", original: "原始自我评价", draft: "岗位微调稿", reasons: ["强调 React 交付经验"],
  evidence: [{ documentId: "resume", page: 1, text: "React 项目", extraction: "pdf_text" }], unsupportedClaims: [], status: "needs_review",
  base: { factId: "self", revision: 1, original: "原始自我评价", evidence: [{ documentId: "resume", page: 1, text: "原始自我评价", extraction: "pdf_text" }] }
};

describe("SelfEvaluationReview", () => {
  it("shows original, draft, reasons and evidence without adopting on render", async () => {
    const approve = vi.fn(async () => reviewableDraft);
    render(<SelfEvaluationReview draft={reviewableDraft} onApprove={approve} onKeepOriginal={vi.fn(async () => reviewableDraft)} />);

    expect(screen.getByRole("heading", { name: "原始自我评价" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "岗位微调稿" })).toBeVisible();
    expect(screen.getByText("强调 React 交付经验")).toBeVisible();
    expect(screen.getByText(/PDF 第 1 页/)).toBeVisible();
    expect(approve).not.toHaveBeenCalled();
  });

  it("uses the returned approval as terminal state and focuses a stable status", async () => {
    const user = userEvent.setup();
    const approve = vi.fn(async (value: string) => ({ ...reviewableDraft, draft: value, status: "approved" as const }));
    const keep = vi.fn(async () => ({ ...reviewableDraft, draft: reviewableDraft.original, status: "approved" as const }));
    render(<SelfEvaluationReview draft={reviewableDraft} onApprove={approve} onKeepOriginal={keep} />);

    const adopt = screen.getByRole("button", { name: "采用此版本" });
    await user.click(adopt);
    expect(approve).toHaveBeenCalledWith("岗位微调稿");
    expect(await screen.findByRole("status")).toHaveTextContent("已采用此版本");
    expect(screen.getByRole("status")).toHaveFocus();
    expect(screen.queryByRole("button", { name: "采用此版本" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("status"));
    expect(approve).toHaveBeenCalledOnce();
  });

  it("supports edit-adopt and explicit keep-original approval", async () => {
    const user = userEvent.setup();
    const approve = vi.fn(async (value: string) => ({ ...reviewableDraft, draft: value, status: "approved" as const }));
    const keep = vi.fn(async () => ({ ...reviewableDraft, draft: reviewableDraft.original, status: "approved" as const }));
    const { unmount } = render(<SelfEvaluationReview draft={reviewableDraft} onApprove={approve} onKeepOriginal={keep} />);

    await user.click(screen.getByRole("button", { name: "编辑后采用" }));
    const editor = screen.getByLabelText("编辑岗位微调稿");
    await user.clear(editor);
    await user.type(editor, "编辑后的稿件");
    await user.click(screen.getByRole("button", { name: "采用编辑稿" }));
    expect(approve).toHaveBeenLastCalledWith("编辑后的稿件");

    unmount();
    render(<SelfEvaluationReview draft={reviewableDraft} onApprove={approve} onKeepOriginal={keep} />);
    await user.click(screen.getByRole("button", { name: "继续使用原文" }));
    expect(keep).toHaveBeenCalledOnce();
    expect(await screen.findByRole("status")).toHaveTextContent("已继续使用原文");
  });

  it("blocks adoption when unsupported claims exist and surfaces an API failure", async () => {
    const user = userEvent.setup();
    const blocked = { ...reviewableDraft, unsupportedClaims: ["Rust"], status: "blocked" as const };
    const { rerender } = render(<SelfEvaluationReview draft={blocked} onApprove={vi.fn()} onKeepOriginal={vi.fn()} />);
    expect(screen.getByText("不支持的声明：Rust")).toBeVisible();
    expect(screen.getByRole("button", { name: "采用此版本" })).toBeDisabled();

    rerender(<SelfEvaluationReview draft={reviewableDraft} onApprove={vi.fn(async () => { throw new Error("network"); })} onKeepOriginal={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "采用此版本" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("采用失败，请重试");
  });
});
