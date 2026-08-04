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
      assessment("filled", "field-filled")
    ]);

    expect(coverage).toMatchObject({
      total: 5, ready: 1, review: 1, missing: 1, unsupported: 1, filled: 1
    });
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
