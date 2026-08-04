import type { ProfileCompleteness, ProfileDocumentSummary } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProfileSummaryBar } from "./ProfileSummaryBar.js";

const completeness: ProfileCompleteness = {
  completed: 38,
  total: 50,
  sections: [{ id: "basics", label: "基本信息", completed: 10, total: 12, missing: ["basics.englishName", "basics.birthDate"] }]
};

const document: ProfileDocumentSummary = {
  documentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  filename: "何庆-简历.pdf",
  importedAt: "2026-08-04T06:32:00.000Z",
  extractedFactCount: 46
};

describe("ProfileSummaryBar", () => {
  it("shows global profile information and exposes one parser entry", async () => {
    const user = userEvent.setup();
    const onOpenParser = vi.fn();
    const onFillMissing = vi.fn();
    render(<ProfileSummaryBar
      candidateName="何庆"
      targetRole="Java 后端开发工程师"
      completeness={completeness}
      missingCount={8}
      latestDocument={document}
      saveState="saved"
      onSave={vi.fn()}
      onOpenParser={onOpenParser}
      onFillMissing={onFillMissing}
    />);

    expect(screen.getByText("何庆")).toBeVisible();
    expect(screen.getByText("目标岗位：Java 后端开发工程师")).toBeVisible();
    expect(screen.getByText("76%")).toBeVisible();
    expect(screen.getByText("8 项待补全")).toBeVisible();
    expect(screen.getByText("何庆-简历.pdf")).toBeVisible();
    expect(screen.getByText("所有更改已保存")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "简历解析" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "简历解析" }));
    await user.click(screen.getByRole("button", { name: "补全资料" }));
    expect(onOpenParser).toHaveBeenCalledTimes(1);
    expect(onFillMissing).toHaveBeenCalledTimes(1);
  });

  it("announces dirty and saving states", () => {
    const { rerender } = render(<ProfileSummaryBar candidateName="候选人" missingCount={0} saveState="dirty" onSave={vi.fn()} onOpenParser={vi.fn()} onFillMissing={vi.fn()} />);
    expect(screen.getByText("有未保存的更改")).toBeVisible();
    rerender(<ProfileSummaryBar candidateName="候选人" missingCount={0} saveState="saving" onSave={vi.fn()} onOpenParser={vi.fn()} onFillMissing={vi.fn()} />);
    expect(screen.getByText("正在保存档案")).toBeVisible();
    expect(screen.getByRole("button", { name: "保存档案" })).toBeDisabled();
  });
});
