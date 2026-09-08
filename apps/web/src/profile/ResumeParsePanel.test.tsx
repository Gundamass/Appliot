import type { CurrentProfileDocumentSummary } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ResumeParsePanel } from "./ResumeParsePanel.js";

function currentDocument(importStatus: CurrentProfileDocumentSummary["importStatus"]): CurrentProfileDocumentSummary {
  return {
    documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    filename: "何庆-简历.pdf",
    importedAt: "2026-09-08T06:32:00.000Z",
    extractedFactCount: importStatus === "completed" ? 46 : 0,
    importStatus
  };
}

const baseProps = {
  open: true,
  operationState: { kind: "idle" } as const,
  onSelectFile: vi.fn(),
  onUpdateOnly: vi.fn(),
  onUpdateAndParse: vi.fn(),
  onRetryParse: vi.fn(),
  onClose: vi.fn()
};

describe("ResumeParsePanel", () => {
  it("offers independent update-only and update-and-parse actions", async () => {
    const user = userEvent.setup();
    const file = new File(["%PDF"], "new-resume.pdf", { type: "application/pdf" });
    const onUpdateOnly = vi.fn();
    const onUpdateAndParse = vi.fn();
    render(<ResumeParsePanel {...baseProps} selectedFile={file} onUpdateOnly={onUpdateOnly} onUpdateAndParse={onUpdateAndParse} />);

    await user.click(screen.getByRole("button", { name: "仅更新简历" }));
    await user.click(screen.getByRole("button", { name: "更新并解析" }));

    expect(onUpdateOnly).toHaveBeenCalledOnce();
    expect(onUpdateAndParse).toHaveBeenCalledOnce();
  });

  it.each([
    ["retained", "未解析"],
    ["importing", "解析中"],
    ["completed", "已解析"],
    ["failed", "解析失败，可重试"]
  ] as const)("renders %s current document status", (status, label) => {
    render(<ResumeParsePanel {...baseProps} currentDocument={currentDocument(status)} />);
    expect(screen.getByText("何庆-简历.pdf")).toBeVisible();
    expect(screen.getByText(label)).toBeVisible();
  });

  it.each([
    { kind: "uploading", mode: "update_only" } as const,
    { kind: "uploading", mode: "update_and_parse" } as const,
    { kind: "parsing", documentId: "0f8fad5b-d9cb-469f-a165-70867728950e" } as const
  ])("locks both actions while an operation is busy", (operationState) => {
    const file = new File(["%PDF"], "resume.pdf", { type: "application/pdf" });
    render(<ResumeParsePanel {...baseProps} selectedFile={file} operationState={operationState} />);
    expect(screen.getByRole("button", { name: "仅更新简历" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "更新并解析" })).toBeDisabled();
    expect(screen.getByLabelText("选择 PDF 简历")).toBeDisabled();
  });

  it.each(["retained", "failed"] as const)("retries parsing a %s current document without a new file", async (status) => {
    const user = userEvent.setup();
    const onRetryParse = vi.fn();
    render(<ResumeParsePanel {...baseProps} currentDocument={currentDocument(status)} onRetryParse={onRetryParse} />);
    await user.click(screen.getByRole("button", { name: "重新解析" }));
    expect(onRetryParse).toHaveBeenCalledOnce();
  });

  it("hides retry when a new file is selected", () => {
    render(<ResumeParsePanel
      {...baseProps}
      currentDocument={currentDocument("failed")}
      selectedFile={new File(["%PDF"], "new.pdf", { type: "application/pdf" })}
    />);
    expect(screen.queryByRole("button", { name: "重新解析" })).not.toBeInTheDocument();
  });

  it("renders nothing while closed", () => {
    const { container } = render(<ResumeParsePanel {...baseProps} open={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
