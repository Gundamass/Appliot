import { describe, expect, it } from "vitest";
import type { CanonicalIntent, PlanState, PlanStep } from "@resume/contracts";
import { createInMemoryEvidenceStore } from "../observations/evidence-store.js";
import { createApplicationAgent } from "./application-agent.js";

const intent = {
  intentId: "intent-application-agent-contract",
  schemaVersion: "1.0.0",
  revision: 1,
  rawInputRef: "message-1",
  primaryGoal: "fill_application",
  subGoals: ["fill_application"],
  entities: {},
  constraints: [],
  preferences: [],
  successCriteria: [],
  riskProfile: { level: "high", requiresHumanApproval: true, reasons: ["external application action"] },
  confidence: 1,
  ambiguities: [],
  missingInformation: [],
  autonomyLevel: "execute_with_approval",
  evidenceRefs: [],
  createdAt: "2026-09-03T00:00:00.000Z"
} satisfies CanonicalIntent;

const step = {
  id: "fill_application-1",
  objective: "fill_application",
  owner: "application",
  status: "running",
  dependsOn: [],
  inputRefs: [intent.intentId],
  outputRefs: [],
  attempt: 0,
  maxAttempts: 2,
  acceptanceCriteria: ["application filled"],
  risk: "high"
} satisfies PlanStep;

const plan = {
  planId: "plan-application-agent-contract",
  intentId: intent.intentId,
  revision: 1,
  steps: [step],
  assumptions: [],
  approvalPoints: [],
  estimatedCost: { steps: 1, toolCalls: 1, tokens: 0, durationMs: 1 },
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z"
} satisfies PlanState;

describe("ApplicationAgent contract", () => {
  it("does not reuse a stale browser node reference", async () => {
    const agent = createApplicationAgent({
      evidenceStore: createInMemoryEvidenceStore(),
      observe: async () => ({
        snapshotId: "new",
        executionEpoch: 2,
        targetFingerprint: "target:new",
        nodeRefs: ["current"]
      }),
      propose: async () => ({
        snapshotId: "new",
        executionEpoch: 2,
        targetFingerprint: "target:new",
        nodeRef: "old",
        operation: "fill" as const
      })
    });

    const result = await agent.execute({
      runId: "run-application-agent",
      taskId: "task-application-agent",
      intent,
      plan,
      step,
      signal: new AbortController().signal,
      executionEpoch: 2
    });

    expect(result.status).toBe("blocked");
    expect(result.blockReason).toBe("stale_observation");
  });
});
