import { describe, expect, it } from "vitest";
import { CanonicalIntentSchema, type CanonicalIntent } from "@resume/contracts";
import { createPlanner } from "./planner.js";

const intentForApplication: CanonicalIntent = CanonicalIntentSchema.parse({
  intentId: "intent-application",
  schemaVersion: "1.0.0",
  revision: 1,
  rawInputRef: "message-1",
  primaryGoal: "prepare_application",
  subGoals: ["identify_target_job", "prepare_application", "fill_application"],
  entities: {
    targetJob: {
      value: "job-1",
      source: "user_explicit",
      confidence: 1,
      evidenceRefs: [],
      requiresConfirmation: false
    }
  },
  constraints: [],
  preferences: [],
  successCriteria: [{ id: "ready", description: "application is ready for review", required: true }],
  riskProfile: {
    level: "high",
    requiresHumanApproval: true,
    reasons: ["external application action"]
  },
  confidence: 0.95,
  ambiguities: [],
  missingInformation: [],
  autonomyLevel: "execute_with_approval",
  evidenceRefs: [],
  createdAt: "2026-09-03T00:00:00.000Z"
});

describe("Planner", () => {
  it("creates a dependency-aware plan with a mandatory final-submit approval point", async () => {
    const planner = createPlanner({
      idFactory: () => "plan-id",
      now: () => "2026-09-03T00:00:00.000Z"
    });

    const plan = await planner.create(intentForApplication);

    expect(plan.approvalPoints.map((point) => point.kind)).toContain("final_submit");
    const finalStep = plan.steps.find((step) => step.risk === "irreversible");
    expect(finalStep).toBeDefined();
    expect(finalStep?.dependsOn.length).toBeGreaterThan(0);
    expect(plan.steps.every((step) => step.maxAttempts > 0)).toBe(true);
  });
});

export { intentForApplication };
