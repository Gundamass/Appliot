import type { ApplicationFieldCoverage } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it } from "vitest";
import { FieldCoveragePanel } from "./FieldCoveragePanel.js";

const coverage: ApplicationFieldCoverage = {
  total: 7,
  ready: 1,
  review: 1,
  missing: 1,
  unsupported: 1,
  filled: 3,
  fields: [
    { fieldId: "name", label: "姓名", semantic: "basics.name", status: "filled", source: "dji_catalog", confidence: 1, reason: "页面回读确认填写成功", evidence: [] },
    { fieldId: "school", label: "毕业院校", semantic: "education[0].institution", status: "filled", source: "dji_catalog", confidence: 1, reason: "页面回读确认填写成功", evidence: [] },
    { fieldId: "project", label: "项目名称", semantic: "projects[0].name", status: "filled", source: "dji_catalog", confidence: 1, reason: "页面回读确认填写成功", evidence: [] },
    { fieldId: "phone", label: "手机号码", semantic: "basics.phone", status: "ready", source: "exact", confidence: 1, reason: "字段映射和资料值均已通过验证", evidence: [] },
    { fieldId: "degree", label: "最高学历", semantic: "education[0].degree", status: "review", source: "semantic", confidence: 0.82, reason: "语义接近，需要确认", evidence: [{ documentId: "resume", page: 1, text: "本科", extraction: "pdf_text" }] },
    { fieldId: "unknown", label: "未命名字段", status: "missing", source: "none", confidence: 0, reason: "档案中没有可安全使用的已确认资料", evidence: [] },
    { fieldId: "captcha", label: "验证码", status: "unsupported", source: "none", confidence: 0, reason: "当前字段不支持安全自动填写", evidence: [] }
  ]
};

it("summarizes coverage and expands only fields that need attention", async () => {
  const user = userEvent.setup();
  render(<FieldCoveragePanel coverage={coverage} />);

  expect(screen.getByText("已填写 3")).toBeVisible();
  expect(screen.getByText("待审核 1")).toBeVisible();
  expect(screen.getByText("缺少资料 1")).toBeVisible();
  expect(screen.getByRole("button", { name: "查看待处理字段" })).toBeVisible();
  expect(screen.queryByText("最高学历")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "查看待处理字段" }));

  expect(screen.getByText("最高学历")).toBeVisible();
  expect(screen.getByText("未命名字段")).toBeVisible();
  expect(screen.getByText("验证码")).toBeVisible();
  expect(screen.queryByText("项目名称")).not.toBeInTheDocument();
  expect(screen.getByText("education[0].degree")).toBeVisible();
  expect(screen.getByText("语义匹配")).toBeVisible();
  expect(screen.getByText("置信度 82%")).toBeVisible();
  expect(screen.getByText("PDF 原文")).toBeVisible();
  expect(screen.queryByRole("button", { name: /提交|发送申请/ })).not.toBeInTheDocument();
});
