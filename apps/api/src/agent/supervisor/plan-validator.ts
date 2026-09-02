import {
  PlanStateSchema,
  type PlanState,
  type PlanStep
} from "@resume/contracts";

export interface PlanValidationError {
  code:
    | "plan_schema_invalid"
    | "step_duplicate"
    | "step_attempt_invalid"
    | "dependency_unknown"
    | "dependency_self"
    | "dependency_cycle"
    | "capability_unknown"
    | "agent_unknown"
    | "approval_point_unknown_step"
    | "approval_point_missing"
    | "revision_invalid"
    | "budget_exceeded";
  stepId?: string;
  detail?: string;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: PlanValidationError[];
  plan?: PlanState;
}

export interface PlanValidator {
  validate(plan: unknown): PlanValidationResult;
  assertValid(plan: unknown): PlanState;
}

export interface PlanValidatorOptions {
  readonly agentNames?: readonly string[];
  readonly capabilityNames?: readonly string[];
  readonly budgetLimits?: {
    maxSteps?: number;
    maxToolCalls?: number;
    maxTokens?: number;
    maxDurationMs?: number;
    maxAttemptsPerStep?: number;
  };
}

export function createPlanValidator(options: PlanValidatorOptions = {}): PlanValidator {
  return {
    validate(rawPlan) {
      const parsed = PlanStateSchema.safeParse(rawPlan);
      if (!parsed.success) {
        return { valid: false, errors: [{ code: "plan_schema_invalid", detail: parsed.error.message }] };
      }
      const plan = parsed.data;
      const errors: PlanValidationError[] = [];
      const stepIds = new Set<string>();
      for (const step of plan.steps) {
        if (stepIds.has(step.id)) errors.push({ code: "step_duplicate", stepId: step.id });
        stepIds.add(step.id);
        if (step.attempt < 0 || step.attempt > step.maxAttempts) {
          errors.push({ code: "step_attempt_invalid", stepId: step.id });
        }
        if (options.budgetLimits?.maxAttemptsPerStep !== undefined
          && step.maxAttempts > options.budgetLimits.maxAttemptsPerStep) {
          errors.push({ code: "budget_exceeded", stepId: step.id, detail: "maxAttemptsPerStep" });
        }
        for (const dependency of step.dependsOn) {
          if (dependency === step.id) errors.push({ code: "dependency_self", stepId: step.id });
          else if (!stepIds.has(dependency) && !plan.steps.some((candidate) => candidate.id === dependency)) {
            errors.push({ code: "dependency_unknown", stepId: step.id, detail: dependency });
          }
        }
        for (const capability of step.capabilityNames ?? []) {
          if (options.capabilityNames !== undefined && !options.capabilityNames.includes(capability)) {
            errors.push({ code: "capability_unknown", stepId: step.id, detail: capability });
          }
        }
        if (options.agentNames !== undefined && !options.agentNames.includes(`${step.owner}_agent`)) {
          errors.push({ code: "agent_unknown", stepId: step.id, detail: `${step.owner}_agent` });
        }
      }

      const visiting = new Set<string>();
      const visited = new Set<string>();
      const byId = new Map(plan.steps.map((step) => [step.id, step]));
      const visit = (step: PlanStep): void => {
        if (visited.has(step.id)) return;
        if (visiting.has(step.id)) {
          errors.push({ code: "dependency_cycle", stepId: step.id });
          return;
        }
        visiting.add(step.id);
        for (const dependency of step.dependsOn) {
          const dependencyStep = byId.get(dependency);
          if (dependencyStep !== undefined) visit(dependencyStep);
        }
        visiting.delete(step.id);
        visited.add(step.id);
      };
      plan.steps.forEach(visit);

      const approvalByStep = new Map(plan.approvalPoints.map((point) => [point.stepId, point]));
      for (const point of plan.approvalPoints) {
        if (!stepIds.has(point.stepId)) errors.push({ code: "approval_point_unknown_step", detail: point.stepId });
      }
      for (const step of plan.steps) {
        if (step.risk === "irreversible") {
          const point = approvalByStep.get(step.id);
          if (point?.kind !== "final_submit" || point.required !== true) {
            errors.push({ code: "approval_point_missing", stepId: step.id, detail: "final_submit" });
          }
        }
        if (step.risk === "high") {
          const point = approvalByStep.get(step.id);
          if (point?.kind !== "high_risk_action" || point.required !== true) {
            errors.push({ code: "approval_point_missing", stepId: step.id, detail: "high_risk_action" });
          }
        }
      }
      if (plan.previousRevision !== undefined && plan.previousRevision >= plan.revision) {
        errors.push({ code: "revision_invalid", detail: "previousRevision must be lower than revision" });
      }
      const limits = options.budgetLimits;
      if ((limits?.maxSteps !== undefined && plan.estimatedCost.steps > limits.maxSteps)
        || (limits?.maxToolCalls !== undefined && plan.estimatedCost.toolCalls > limits.maxToolCalls)
        || (limits?.maxTokens !== undefined && plan.estimatedCost.tokens > limits.maxTokens)
        || (limits?.maxDurationMs !== undefined && plan.estimatedCost.durationMs > limits.maxDurationMs)) {
        errors.push({ code: "budget_exceeded" });
      }
      return errors.length === 0 ? { valid: true, errors: [], plan } : { valid: false, errors, plan };
    },
    assertValid(rawPlan) {
      const result = this.validate(rawPlan);
      if (!result.valid || result.plan === undefined) {
        throw new Error(`plan_invalid:${result.errors.map((error) => error.code).join(",")}`);
      }
      return result.plan;
    }
  };
}
