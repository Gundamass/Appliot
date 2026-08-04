import type { ApplicationContentReview } from "@resume/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationEvidenceDrawer } from "./ApplicationEvidenceDrawer.js";

afterEach(() => vi.unstubAllGlobals());

const review: ApplicationContentReview = {
  id: "review-1",
  fieldId: "self-evaluation",
  fieldLabel: "自我评价",
  original: "原始自我评价",
  draft: "面向后端岗位的微调稿",
  reasons: ["突出后端项目经验"],
  evidence: [{ documentId: "resume-1", page: 2, text: "负责 Java 后端开发", extraction: "pdf_text" }],
  unsupportedClaims: [],
  status: "needs_review"
};

it("展示投递字段、草稿值和对应 PDF 页码", () => {
  render(<ApplicationEvidenceDrawer review={review} returnFocusTo={null} onClose={vi.fn()} />);

  const dialog = screen.getByRole("dialog", { name: "证据映射" });
  expect(within(dialog).getByRole("heading", { level: 3, name: "自我评价" })).toBeVisible();
  expect(within(dialog).getByText("面向后端岗位的微调稿")).toBeVisible();
  expect(within(dialog).getByRole("heading", { name: "页码 2" })).toBeVisible();
  expect(within(dialog).getByTitle("原始 PDF 第 2 页")).toHaveAttribute(
    "src",
    expect.stringContaining("/api/profile/documents/resume-1/pages/2/image")
  );
});

it("用户证据不触发 OCR 定位，也不展示 PDF 预览", () => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  render(<ApplicationEvidenceDrawer
    review={{
      ...review,
      draft: "用户确认后的自我评价",
      evidence: [{
        documentId: "user-record",
        page: 1,
        text: "用户确认后的内容",
        extraction: "user"
      }]
    }}
    returnFocusTo={null}
    onClose={vi.fn()}
  />);

  const dialog = screen.getByRole("dialog", { name: "证据映射" });
  expect(within(dialog).getByText("用户确认后的自我评价")).toBeVisible();
  expect(within(dialog).getByRole("heading", { level: 3, name: "用户提供记录" })).toBeVisible();
  expect(within(dialog).getByText("用户确认后的内容")).toBeVisible();
  expect(within(dialog).queryByText("页码")).not.toBeInTheDocument();
  expect(within(dialog).queryByTitle(/原始 PDF/)).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("点击第二条 OCR 证据后切换原文页并显示定位高亮", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    match: "exact",
    boxes: [{ x1: 100, y1: 200, x2: 420, y2: 360 }]
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);

  render(<ApplicationEvidenceDrawer
    review={{
      ...review,
      evidence: [
        { documentId: "resume-1", page: 1, text: "第一条 PDF 原文", extraction: "pdf_text" },
        { documentId: "resume-1", page: 2, text: "第二条 OCR 原文", extraction: "ocr" }
      ]
    }}
    returnFocusTo={null}
    onClose={vi.fn()}
  />);

  const dialog = screen.getByRole("dialog", { name: "证据映射" });
  expect(within(dialog).getByRole("heading", { name: "页码 1" })).toBeVisible();
  expect(within(dialog).getByText("第一条 PDF 原文")).toBeVisible();

  fireEvent.click(within(dialog).getByRole("button", { name: "OCR 识别，第 2 页" }));

  expect(within(dialog).getByRole("heading", { name: "页码 2" })).toBeVisible();
  expect(within(dialog).getByText("第二条 OCR 原文")).toBeVisible();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/profile/documents/resume-1/pages/2/grounding?text=%E7%AC%AC%E4%BA%8C%E6%9D%A1%20OCR%20%E5%8E%9F%E6%96%87",
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  ));
  expect(await within(dialog).findByTestId("evidence-highlight-0")).toBeVisible();
});
