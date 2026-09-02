import { describe, expect, it } from "vitest";
import { PlanStateSchema } from "@resume/contracts";
import { createPlanValidator } from "./plan-validator.js";
import { createPlanner } from "./planner.js";
import { intentForApplication } from "./planner.test.js";

describe("PlanValidator", () => {
  it("rejects dependency cycles and unknown capabilities before dispatch", async () => {
    const plan = await createPlanner({ idFactory: () => "plan-id", now: () => "2026-09-03T00:00:00.000Z" })
      .create(intentForApplication);
    const cyclic = PlanStateSchema.parse({
      ...plan,
      steps: plan.steps.map((step, index) => index === 0
        ? { ...step, dependsOn: [plan.steps.at(-1)!.id], capabilityNames: ["missing.capability"] }
        : step)
    });

    const result = createPlanValidator({ capabilityNames: ["data.read"] }).validate(cyclic);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "dependency_cycle" }),
      expect.objectContaining({ code: "capability_unknown" })
    ]));
  });

  it("requires a mandatory high-risk approval point", async () => {
    const plan = await createPlanner({ idFactory: () => "plan-id", now: () => "2026-09-03T00:00:00.000Z" })
      .create(intentForApplication);
    const highRiskStep = plan.steps.find((step) => step.risk === "high");
    expect(highRiskStep).toBeDefined();
    const invalid = PlanStateSchema.parse({
      ...plan,
      approvalPoints: plan.approvalPoints.map((point) => point.stepId === highRiskStep?.id
        ? { ...point, kind: "final_submit" as const, required: false }
        : point)
    });

    const result = createPlanValidator().validate(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "approval_point_missing", stepId: highRiskStep?.id })
    ]));
  });

  it("requires an explicit final_submit capability for irreversible steps", async () => {
    const plan = await createPlanner({ idFactory: () => "plan-id", now: () => "2026-09-03T00:00:00.000Z" })
      .create({ ...intentForApplication, primaryGoal: "submit_application" });
    const irreversible = plan.steps.find((step) => step.risk === "irreversible");
    expect(irreversible).toBeDefined();
    const invalid = PlanStateSchema.parse({
      ...plan,
      steps: plan.steps.map((step) => step.id === irreversible?.id
        ? { ...step, capabilityNames: undefined }
        : step)
    });

    const result = createPlanValidator().validate(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "irreversible_capability_missing", stepId: irreversible?.id })
    ]));
  });

  it("requires a complete approval binding for irreversible steps", async () => {
    const plan = await createPlanner({ idFactory: () => "plan-id", now: () => "2026-09-03T00:00:00.000Z" })
      .create({ ...intentForApplication, primaryGoal: "submit_application" });
    const irreversible = plan.steps.find((step) => step.risk === "irreversible");
    expect(irreversible).toBeDefined();

    const invalid = PlanStateSchema.parse({
      ...plan,
      steps: plan.steps.map((step) => step.risk === "irreversible"
        ? { ...step, approvalBinding: undefined }
        : step)
    });
    const result = createPlanValidator().validate(invalid);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "approval_binding_missing", stepId: irreversible?.id })
    ]));
  });
});
