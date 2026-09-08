import { describe, expect, it } from "vitest";
import { PlanStateSchema, SupervisorDecisionSchema } from "./agent-plan.js";

describe("agent plan contracts", () => {
  it("accepts a dependency-aware plan with an approval point", () => {
    const plan = PlanStateSchema.parse({
      planId: "plan-1",
      intentId: "intent-1",
      revision: 1,
      steps: [
        {
          id: "prepare",
          objective: "准备申请表",
          owner: "application",
          status: "pending",
          dependsOn: [],
          inputRefs: ["intent-1"],
          outputRefs: ["draft-1"],
          attempt: 0,
          maxAttempts: 2,
          acceptanceCriteria: ["所有字段均有值或明确待确认"],
          risk: "medium"
        },
        {
          id: "submit",
          objective: "提交申请",
          owner: "application",
          status: "pending",
          dependsOn: ["prepare"],
          inputRefs: ["draft-1"],
          outputRefs: [],
          attempt: 0,
          maxAttempts: 1,
          acceptanceCriteria: ["用户批准且 payload hash 一致"],
          risk: "irreversible"
        }
      ],
      assumptions: [],
      approvalPoints: [{ id: "approval-1", kind: "final_submit", stepId: "submit", required: true }],
      estimatedCost: { steps: 2, toolCalls: 3, tokens: 1000, durationMs: 10_000 },
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z"
    });

    expect(plan.steps[1]?.dependsOn).toEqual(["prepare"]);
  });

  it("rejects a dispatch decision without a reason", () => {
    expect(SupervisorDecisionSchema.safeParse({
      type: "dispatch_agent",
      agent: "application",
      input: {},
      reason: ""
    }).success).toBe(false);
  });
});
