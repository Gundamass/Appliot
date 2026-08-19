import type { AdapterReviewSummary, HintPackDefinition } from "@resume/contracts";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AdapterReviewPanel } from "./AdapterReviewPanel.js";

function definition(): HintPackDefinition {
  return {
    schemaVersion: 1,
    packId: "example-ats",
    version: "1.0.0",
    match: {
      sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/apply"] }],
      stages: ["application_form"],
      requiredTextSignals: [],
      pageFingerprintHashes: []
    },
    sectionRules: [],
    fieldRules: [{
      ruleId: "name",
      profilePath: "basics.name",
      labelAliases: ["ats:sha256:24:fixture"],
      sections: ["basics"],
      controlTypes: ["text"],
      confidence: 1
    }],
    actionRules: [],
    fixtures: [{ fixtureId: "fixture-basic", expectedProfilePaths: ["basics.name"] }]
  };
}

function replayVerifiedWithoutAi(): AdapterReviewSummary {
  return {
    proposal: {
      proposalId: "proposal-1",
      taskId: "task-1",
      lifecycleStatus: "candidate",
      provider: "fixture-provider",
      model: "fixture-model",
      promptVersion: "hint-proposal-v1",
      inputHash: "a".repeat(64),
      outputHash: "b".repeat(64),
      definition: definition(),
      unsupportedBoundaries: [],
      rejectedActions: [],
      createdAt: "2026-08-17T00:00:00.000Z"
    },
    replayReports: [{
      reportId: "report-1",
      proposalId: "proposal-1",
      fixtureId: "fixture-basic",
      status: "passed",
      assertions: [{ code: "zero_submit", passed: true, detail: "redacted:assertion:zero_submit:passed:report-passed" }],
      submissionCount: 0,
      inputHash: "c".repeat(64),
      createdAt: "2026-08-17T00:01:00.000Z"
    }],
    lifecycleStatus: "replay_verified",
    aiReviewUnavailable: true,
    writeBlocked: true
  };
}

it("shows deterministic, AI, and human layers and requires degraded-review acknowledgement", async () => {
  const user = userEvent.setup();
  const onDecision = vi.fn();
  render(<AdapterReviewPanel
    review={replayVerifiedWithoutAi()}
    busy={false}
    onReplay={vi.fn()}
    onAiReview={vi.fn()}
    onDecision={onDecision}
    onRevise={vi.fn()}
  />);

  expect(screen.getByRole("heading", { name: "确定性校验" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "AI 辅助审阅" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "人工最终认证" })).toBeVisible();
  expect(screen.getByRole("button", { name: "认证此版本" })).toBeDisabled();
  expect(screen.queryByText("proposal-1")).not.toBeInTheDocument();

  await user.click(screen.getByRole("checkbox", { name: "我已确认 AI 审阅不可用，仍由人工承担最终判断" }));
  expect(screen.getByRole("button", { name: "认证此版本" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "认证此版本" }));

  expect(onDecision).toHaveBeenCalledWith({
    decision: "certify",
    aiReviewUnavailable: true,
    acknowledgedAiUnavailable: true
  });
});
