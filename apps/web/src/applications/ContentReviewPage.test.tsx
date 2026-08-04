import type { ApplicationContentReview } from "@resume/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ContentReviewPage } from "./ContentReviewPage.js";

afterEach(() => vi.unstubAllGlobals());

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
  expect(screen.getByRole("button", { name: "查看原文" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "查看第 1 页证据" })).not.toBeInTheDocument();
  expect(approve).not.toHaveBeenCalled();

  await userEvent.clear(screen.getByLabelText("最终填写内容"));
  await userEvent.type(screen.getByLabelText("最终填写内容"), "用户确认后的最终稿");
  await userEvent.click(screen.getByRole("button", { name: "采用最终稿" }));
  expect(approve).toHaveBeenCalledWith("用户确认后的最终稿");
});

it("在投递审核中查看 PDF 原文并在关闭后恢复焦点", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    match: "exact",
    boxes: [{ x1: 100, y1: 200, x2: 600, y2: 260 }]
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  render(<ContentReviewPage
    review={{
      ...review,
      fieldLabel: "自我评价",
      draft: "面向后端岗位的微调稿",
      evidence: [{ documentId: "resume-ocr", page: 2, text: "负责 Java 后端开发", extraction: "ocr" }]
    }}
    busy={false}
    canApprove
    canReject
    onApprove={vi.fn()}
    onReject={vi.fn()}
  />);

  const trigger = screen.getByRole("button", { name: "查看原文" });
  await user.click(trigger);

  const dialog = screen.getByRole("dialog", { name: "证据映射" });
  expect(within(dialog).getByText("自我评价")).toBeVisible();
  expect(within(dialog).getByText("面向后端岗位的微调稿")).toBeVisible();
  expect(within(dialog).getByRole("heading", { name: "页码 2" })).toBeVisible();
  await waitFor(() => expect(within(dialog).getByTestId("evidence-highlight-0")).toBeVisible());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/profile/documents/resume-ocr/pages/2/grounding?text=%E8%B4%9F%E8%B4%A3%20Java%20%E5%90%8E%E7%AB%AF%E5%BC%80%E5%8F%91",
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
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
