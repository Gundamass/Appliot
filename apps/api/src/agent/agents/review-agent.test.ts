import { describe, expect, it } from "vitest";
import type { CanonicalIntent, PlanState, PlanStep } from "@resume/contracts";
import { createReviewAgent } from "./review-agent.js";

const intent = {
  intentId: "intent-review-agent",
  schemaVersion: "1.0.0",
  revision: 1,
  rawInputRef: "message-1",
  primaryGoal: "prepare_application",
  subGoals: ["review_result"],
  entities: {},
  constraints: [],
  preferences: [],
  successCriteria: [],
  riskProfile: { level: "high", requiresHumanApproval: true, reasons: ["final review"] },
  confidence: 1,
  ambiguities: [],
  missingInformation: [],
  autonomyLevel: "execute_with_approval",
  evidenceRefs: [],
  createdAt: "2026-09-03T00:00:00.000Z"
} satisfies CanonicalIntent;

const step = {
  id: "review_result-1",
  objective: "review_result",
  owner: "review",
  status: "running",
  dependsOn: [],
  inputRefs: [intent.intentId],
  outputRefs: [],
  attempt: 0,
  maxAttempts: 1,
  acceptanceCriteria: ["review complete"],
  risk: "high"
} satisfies PlanStep;

const plan = {
  planId: "plan-review-agent",
  intentId: intent.intentId,
  revision: 1,
  steps: [step],
  assumptions: [],
  approvalPoints: [],
  estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1 },
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z"
} satisfies PlanState;

describe("ReviewAgent", () => {
  it("blocks a final review with missing evidence and never submits", async () => {
    const agent = createReviewAgent();
    const result = await agent.execute({
      runId: "run-review-agent",
      taskId: "task-review-agent",
      intent,
      plan,
      step,
      signal: new AbortController().signal,
      executionEpoch: 0,
      input: { payload: { name: "Candidate" }, evidenceRefs: [], targetFingerprint: "target-1" }
    });

    expect(result.status).toBe("blocked");
    expect(result.blockReason).toBe("evidence_incomplete");
    expect(result.submitted).toBe(false);
  });
});
