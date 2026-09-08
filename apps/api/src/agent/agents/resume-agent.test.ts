import { describe, expect, it } from "vitest";
import type { CanonicalIntent, PlanState, PlanStep } from "@resume/contracts";
import { createInMemoryEvidenceStore } from "../observations/evidence-store.js";
import { createResumeAgent } from "./resume-agent.js";

const intent = {
  intentId: "intent-resume-agent",
  schemaVersion: "1.0.0",
  revision: 1,
  rawInputRef: "message-1",
  primaryGoal: "analyze_resume",
  subGoals: ["analyze_resume"],
  entities: {},
  constraints: [],
  preferences: [],
  successCriteria: [],
  riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
  confidence: 1,
  ambiguities: [],
  missingInformation: [],
  autonomyLevel: "prepare",
  evidenceRefs: [],
  createdAt: "2026-09-03T00:00:00.000Z"
} satisfies CanonicalIntent;

const step = {
  id: "analyze_resume-1",
  objective: "analyze_resume",
  owner: "resume",
  status: "running",
  dependsOn: [],
  inputRefs: [intent.intentId],
  outputRefs: [],
  attempt: 0,
  maxAttempts: 2,
  acceptanceCriteria: ["resume analyzed"],
  risk: "low"
} satisfies PlanStep;

const plan = {
  planId: "plan-resume-agent",
  intentId: intent.intentId,
  revision: 1,
  steps: [step],
  assumptions: [],
  approvalPoints: [],
  estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1 },
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z"
} satisfies PlanState;

describe("ResumeAgent", () => {
  it("emits fact and document evidence references without copying extracted text", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const agent = createResumeAgent({
      evidenceStore,
      ingest: async () => ({
        documentRef: "document:resume-1",
        documentHash: "a".repeat(64),
        facts: [{ fieldPath: "basics.name", confidence: 0.99 }]
      })
    });

    const result = await agent.execute({
      runId: "run-resume-agent",
      taskId: "task-resume-agent",
      intent,
      plan,
      step,
      signal: new AbortController().signal,
      executionEpoch: 0
    });

    expect(result.status).toBe("completed");
    expect(result.evidenceRefs?.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("basics.name");
  });
});
