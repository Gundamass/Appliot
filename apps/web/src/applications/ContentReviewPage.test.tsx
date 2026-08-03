import type { ApplicationContentReview } from "@resume/contracts";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ContentReviewPage } from "./ContentReviewPage.js";

const review: ApplicationContentReview = {
  id: "review-1",
  fieldId: "self-evaluation",
  fieldLabel: "自我评价",
  original: "原始自我评价",
  draft: "面向后端岗位的微调稿",
  reasons: ["突出已验证的后端项目经验"],
  evidence: [{ documentId: "resume", page: 1, text: "负责 Java 后端开发", extraction: "pdf_text" }],
  unsupportedClaims: [],
  status: "needs_review"
};

it("展示原文、草稿、可编辑最终稿、理由和证据，且不会自动采用", async () => {
  const approve = vi.fn();
  render(<ContentReviewPage review={review} busy={false} canApprove canReject onApprove={approve} onReject={vi.fn()} />);

  expect(screen.getByText("原始自我评价")).toBeVisible();
  expect(within(screen.getByRole("heading", { name: "建议草稿" }).closest("article")!).getByText("面向后端岗位的微调稿")).toBeVisible();
  expect(screen.getByText("突出已验证的后端项目经验")).toBeVisible();
  expect(screen.getByRole("link", { name: "查看第 1 页证据" })).toHaveAttribute("href", "/api/profile/documents/resume/pdf#page=1");
  expect(approve).not.toHaveBeenCalled();

  await userEvent.clear(screen.getByLabelText("最终填写内容"));
  await userEvent.type(screen.getByLabelText("最终填写内容"), "用户确认后的最终稿");
  await userEvent.click(screen.getByRole("button", { name: "采用最终稿" }));
  expect(approve).toHaveBeenCalledWith("用户确认后的最终稿");
});

it("可以明确继续使用原文或拒绝内容", async () => {
  const user = userEvent.setup();
  const approve = vi.fn();
  const reject = vi.fn();
  render(<ContentReviewPage review={review} busy={false} canApprove canReject onApprove={approve} onReject={reject} />);

  await user.click(screen.getByRole("button", { name: "继续使用原文" }));
  expect(approve).toHaveBeenCalledWith("原始自我评价");
  await user.click(screen.getByRole("button", { name: "拒绝并停止" }));
  expect(reject).toHaveBeenCalledOnce();
});

it("阻断草稿只展示风险和拒绝操作", () => {
  render(<ContentReviewPage
    review={{ ...review, status: "blocked", unsupportedClaims: ["新增了未验证的 Rust 经验"] }}
    busy={false}
    canApprove
    canReject
    onApprove={vi.fn()}
    onReject={vi.fn()}
  />);

  expect(screen.getByRole("alert")).toHaveTextContent("新增了未验证的 Rust 经验");
  expect(screen.queryByRole("button", { name: "采用最终稿" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "继续使用原文" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "拒绝并停止" })).toBeVisible();
});

it("服务端未授权时只展示审核内容", () => {
  render(<ContentReviewPage review={review} busy={false} canApprove={false} canReject={false} onApprove={vi.fn()} onReject={vi.fn()} />);

  expect(screen.getByText("原始自我评价")).toBeVisible();
  expect(screen.queryByRole("button", { name: "采用最终稿" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "继续使用原文" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "拒绝并停止" })).not.toBeInTheDocument();
});
