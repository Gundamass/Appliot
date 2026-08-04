import type { ProfileDocumentSummary } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ResumeParsePanel } from "./ResumeParsePanel.js";

const document: ProfileDocumentSummary = {
  documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  filename: "何庆-简历.pdf",
  importedAt: "2026-08-04T06:32:00.000Z",
  extractedFactCount: 46
};

describe("ResumeParsePanel", () => {
  it("shows the latest parsed resume and supports file selection", async () => {
    const user = userEvent.setup();
    const onSelectFile = vi.fn();
    const onClose = vi.fn();
    render(<ResumeParsePanel
      open
      uploadState="idle"
      latestDocument={document}
      onSelectFile={onSelectFile}
      onUpload={vi.fn()}
      onRetry={vi.fn()}
      onClose={onClose}
    />);

    expect(screen.getByText("何庆-简历.pdf")).toBeVisible();
    expect(screen.getByText("已提取 46 项资料")).toBeVisible();
    const file = new File(["%PDF"], "new-resume.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("选择 PDF 简历"), file);
    expect(onSelectFile).toHaveBeenCalledWith(file);
    await user.click(screen.getByRole("button", { name: "收起简历解析" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows retry controls when the imported profile refresh fails", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ResumeParsePanel
      open
      uploadState="accepted_refresh_error"
      uploadMessage="简历已导入，但资料刷新失败"
      latestDocument={document}
      onSelectFile={vi.fn()}
      onUpload={vi.fn()}
      onRetry={onRetry}
      onClose={vi.fn()}
    />);

    expect(screen.getByRole("alert")).toHaveTextContent("简历已导入，但资料刷新失败");
    await user.click(screen.getByRole("button", { name: "重新刷新资料" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("locks file controls while uploading and while imported facts refresh", () => {
    const file = new File(["%PDF"], "resume.pdf", { type: "application/pdf" });
    const { rerender } = render(<ResumeParsePanel open selectedFile={file} uploadState="uploading" onSelectFile={vi.fn()} onUpload={vi.fn()} onRetry={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByLabelText("选择 PDF 简历")).toBeDisabled();
    expect(screen.getByRole("button", { name: "上传并提取" })).toHaveTextContent("正在上传");
    expect(screen.getByRole("progressbar", { name: "正在上传 resume.pdf" })).toBeVisible();

    rerender(<ResumeParsePanel open uploadState="accepted_refreshing" uploadMessage="简历已导入，正在刷新资料" onSelectFile={vi.fn()} onUpload={vi.fn()} onRetry={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText("选择 PDF 简历")).toBeDisabled();
    expect(screen.getByText("简历已导入，正在刷新资料")).toBeVisible();
  });

  it("renders nothing while closed", () => {
    const { container } = render(<ResumeParsePanel open={false} uploadState="idle" onSelectFile={vi.fn()} onUpload={vi.fn()} onRetry={vi.fn()} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
