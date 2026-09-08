import { describe, expect, it } from "vitest";
import type { CanonicalIntent, PlanState, PlanStep } from "@resume/contracts";
import { createInMemoryEvidenceStore } from "../observations/evidence-store.js";
import { createJobMatchingAgent } from "./job-matching-agent.js";

const intent = {
  intentId: "intent-job-agent",
  schemaVersion: "1.0.0",
  revision: 1,
  rawInputRef: "message-1",
  primaryGoal: "match_resume_to_job",
  subGoals: ["match_resume_to_job"],
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
  id: "match_resume_to_job-1",
  objective: "match_resume_to_job",
  owner: "job_matching",
  status: "running",
  dependsOn: [],
  inputRefs: [intent.intentId],
  outputRefs: [],
  attempt: 0,
  maxAttempts: 2,
  acceptanceCriteria: ["job requirements matched"],
  risk: "low"
} satisfies PlanStep;

const plan = {
  planId: "plan-job-agent",
  intentId: intent.intentId,
  revision: 1,
  steps: [step],
  assumptions: [],
  approvalPoints: [],
  estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1 },
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z"
} satisfies PlanState;

describe("JobMatchingAgent", () => {
  it("returns requirement advisories instead of inventing a match", async () => {
    const agent = createJobMatchingAgent({
      evidenceStore: createInMemoryEvidenceStore(),
      match: async () => ({
        outputRef: "job-match:result-1",
        requirements: [{ requirementId: "req-1", outcome: "unknown", confidence: 0.42 }]
      })
    });

    const result = await agent.execute({
      runId: "run-job-agent",
      taskId: "task-job-agent",
      intent,
      plan,
      step,
      signal: new AbortController().signal,
      executionEpoch: 0
    });

    expect(result.status).toBe("completed");
    expect(result.advisories).toEqual([expect.objectContaining({ requirementId: "req-1", outcome: "unknown" })]);
  });
});
