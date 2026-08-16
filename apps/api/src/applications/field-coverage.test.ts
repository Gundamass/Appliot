import { describe, expect, it } from "vitest";
import type { ApplicationFieldAssessment } from "@resume/contracts";
import { createFieldCoverageStore, summarizeFieldCoverage } from "./field-coverage.js";

describe("field coverage", () => {
  it("summarizes every assessment status", () => {
    const coverage = summarizeFieldCoverage([
      assessment("ready", "field-ready"),
      assessment("review", "field-review"),
      assessment("missing", "field-missing"),
      assessment("unsupported", "field-unsupported"),
      assessment("filled", "field-filled"),
      assessment("failed", "field-failed")
    ]);

    expect(coverage).toMatchObject({
      total: 6, ready: 1, review: 1, missing: 1, unsupported: 1, filled: 1, failed: 1
    });
  });

  it("keeps execution failures separate from missing profile facts", () => {
    const store = createFieldCoverageStore();
    store.record("task-1", assessment("ready", "field-major"));

    store.markFailed("task-1", "field-major", "下拉选项回读失败");

    expect(store.snapshot("task-1")).toMatchObject({
      total: 1,
      missing: 0,
      failed: 1,
      fields: [expect.objectContaining({
        fieldId: "field-major",
        status: "failed",
        reason: "下拉选项回读失败"
      })]
    });
  });

  it("does not overwrite an audit failure when the reverted page value is non-empty", () => {
    const store = createFieldCoverageStore();
    store.record("task-1", {
      ...assessment("ready", "field-major"),
      label: "Major",
      semantic: "education[0].major"
    });
    store.markFailed("task-1", "field-major", "controlled_value_reverted");

    store.markUserFilled("task-1", {
      fieldId: "field-major",
      label: "Major",
      semantic: "education[0].major"
    });

    expect(store.snapshot("task-1")?.fields).toContainEqual(expect.objectContaining({
      fieldId: "field-major",
      status: "failed",
      reason: "controlled_value_reverted"
    }));
  });

  it("replaces an older field decision and removes stale fields", () => {
    const store = createFieldCoverageStore();
    store.record("task-1", assessment("ready", "field-school"));
    store.record("task-1", assessment("filled", "field-school"));
    store.record("task-1", assessment("missing", "field-phone"));
    store.retain("task-1", new Set(["field-school"]));

    expect(store.snapshot("task-1")).toMatchObject({
      total: 1,
      filled: 1,
      fields: [expect.objectContaining({ fieldId: "field-school", status: "filled" })]
    });
  });

  it("marks a recovered field for final review", () => {
    const store = createFieldCoverageStore();
    store.record("task-1", assessment("ready", "field-month"));

    store.markFilled("task-1", "field-month", ["control_recovered_after_readback_mismatch"]);

    expect(store.snapshot("task-1")?.fields).toContainEqual(expect.objectContaining({
      fieldId: "field-month",
      status: "review",
      reason: "已自动恢复并完成填写，建议在最终审核时确认实际选项"
    }));
  });

  it("replaces a filled assessment when a dynamic form reuses the field id", () => {
    const store = createFieldCoverageStore();
    store.record("task-1", {
      ...assessment("filled", "field-reused"),
      label: "项目描述",
      semantic: "projects[0].description"
    });

    store.markUserFilled("task-1", {
      fieldId: "field-reused",
      label: "起止时间 月",
      semantic: "projects[1].startDate.month"
    });

    expect(store.snapshot("task-1")?.fields).toContainEqual(expect.objectContaining({
      fieldId: "field-reused",
      label: "起止时间 月",
      semantic: "projects[1].startDate.month",
      status: "filled"
    }));
  });
});

function assessment(status: ApplicationFieldAssessment["status"], fieldId: string): ApplicationFieldAssessment {
  return {
    fieldId,
    label: fieldId,
    status,
    source: status === "filled" ? "user" : "exact",
    confidence: 1,
    reason: "测试决策",
    evidence: []
  };
}
