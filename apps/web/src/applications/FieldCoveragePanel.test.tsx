import type { ApplicationFieldCoverage } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it } from "vitest";
import { FieldCoveragePanel } from "./FieldCoveragePanel.js";

const coverage: ApplicationFieldCoverage = {
  total: 8,
  ready: 1,
  review: 1,
  missing: 1,
  failed: 1,
  unsupported: 1,
  filled: 3,
  fields: [
    { fieldId: "name", label: "姓名", semantic: "basics.name", status: "filled", source: "dji_catalog", confidence: 1, reason: "页面回读确认填写成功", evidence: [] },
    { fieldId: "school", label: "毕业院校", semantic: "education[0].institution", status: "filled", source: "dji_catalog", confidence: 1, reason: "页面回读确认填写成功", evidence: [] },
    { fieldId: "project", label: "项目名称", semantic: "projects[0].name", status: "filled", source: "dji_catalog", confidence: 1, reason: "页面回读确认填写成功", evidence: [] },
    { fieldId: "phone", label: "手机号码", semantic: "basics.phone", status: "ready", source: "exact", confidence: 1, reason: "字段映射和资料值均已通过验证", evidence: [] },
    { fieldId: "degree", label: "最高学历", semantic: "education[0].degree", status: "review", source: "semantic", confidence: 0.82, reason: "语义接近，需要确认", evidence: [{ documentId: "resume", page: 1, text: "本科", extraction: "pdf_text" }] },
    { fieldId: "unknown", label: "未命名字段", status: "missing", source: "none", confidence: 0, reason: "档案中没有可安全使用的已确认资料", evidence: [] },
    { fieldId: "captcha", label: "验证码", status: "unsupported", source: "none", confidence: 0, reason: "当前字段不支持安全自动填写", evidence: [] },
    { fieldId: "major", label: "本科专业", semantic: "education[0].major", status: "failed", source: "semantic", confidence: 0.79, reason: "搜索控件两次尝试后仍未选中", evidence: [] }
  ]
};

it("shows the immutable certified pack provenance without proposal or model data", async () => {
  const user = userEvent.setup();
  const certifiedCoverage: ApplicationFieldCoverage = {
    total: 1, ready: 1, review: 0, missing: 0, failed: 0, unsupported: 0, filled: 0,
    fields: [{
      fieldId: "school", label: "毕业院校", semantic: "education[0].institution", status: "ready", source: "certified_hint", confidence: 0.93,
      reason: "认证提示包已完成字段匹配", evidence: [],
      semanticProvenance: { packId: "example-ats", packVersion: "1.2.3", confidence: 0.93, certification: "certified" }
    }]
  };
  render(<FieldCoveragePanel coverage={certifiedCoverage} />);

  await user.click(screen.getByText("查看填写明细"));

  expect(screen.getByText("认证 ATS 提示包")).toBeVisible();
  expect(screen.getByText("example-ats@1.2.3 · 已认证 · 93%")).toBeVisible();
  expect(screen.queryByText(/proposal-|deepseek|sha256:/iu)).not.toBeInTheDocument();
});

it("keeps one compact filling-details disclosure with failures and RAG misses", async () => {
  const user = userEvent.setup();
  render(<FieldCoveragePanel coverage={coverage} />);

  const disclosure = screen.getByLabelText("查看填写明细");
  expect(disclosure).not.toHaveAttribute("open");
  expect(screen.getByText("已填写 3")).not.toBeVisible();
  expect(screen.getByText("最高学历")).not.toBeVisible();

  await user.click(screen.getByText("查看填写明细"));

  expect(disclosure).toHaveAttribute("open");
  expect(screen.getByText("已填写 3")).toBeVisible();
  expect(screen.getByText("待确认 1")).toBeVisible();
  expect(screen.getByText("需补充 1")).toBeVisible();
  expect(screen.getByText("填写失败 1")).toBeVisible();
  expect(screen.getByRole("heading", { name: "教育经历" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "项目经历" })).toBeVisible();
  expect(screen.getByText("最高学历")).toBeVisible();
  expect(screen.getByText("未命名字段")).toBeVisible();
  expect(screen.getByText("验证码")).toBeVisible();
  expect(screen.getByText("本科专业")).toBeVisible();
  expect(screen.getByText("已跳过：当前栏目没有达到阈值的档案字段")).toBeVisible();
  expect(screen.getByText("搜索控件两次尝试后仍未选中")).toBeVisible();
  expect(screen.getByText("项目名称")).toBeVisible();
  expect(screen.getByText("education[0].degree")).toBeVisible();
  expect(screen.getAllByText("语义匹配")).toHaveLength(2);
  expect(screen.getByText("置信度 82%")).toBeVisible();
  expect(screen.getByText("PDF 原文")).toBeVisible();
  expect(screen.queryByRole("button", { name: /提交|发送申请/ })).not.toBeInTheDocument();
});
