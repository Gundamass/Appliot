import {
  PlanStateSchema,
  type ApprovalPoint,
  type CanonicalIntent,
  type PlanAssumption,
  type PlanProposal,
  type PlanRisk,
  type PlanStep,
  type PlanStepOwner,
  type SubGoal
} from "@resume/contracts";
import { randomUUID } from "node:crypto";

export interface PlannerContext {
  readonly availableCapabilities?: readonly string[];
  readonly maxAttemptsPerStep?: number;
  readonly maxSteps?: number;
}

export interface Planner {
  create(intent: CanonicalIntent, context?: PlannerContext): Promise<PlanProposal>;
}

export interface PlannerOptions {
  readonly idFactory?: () => string;
  readonly now?: () => string;
  readonly maxAttemptsPerStep?: number;
  readonly maxSteps?: number;
  readonly availableCapabilities?: readonly string[];
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_MAX_STEPS = 32;

/**
 * Deterministic planning is the safety floor. A model may propose a richer
 * plan later, but this planner always creates an explicit dependency chain and
 * an approval point for every irreversible application action.
 */
export function createPlanner(options: PlannerOptions = {}): Planner {
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async create(intent, context = {}) {
      const maxSteps = context.maxSteps ?? options.maxSteps ?? DEFAULT_MAX_STEPS;
      const maxAttempts = context.maxAttemptsPerStep ?? options.maxAttemptsPerStep ?? DEFAULT_MAX_ATTEMPTS;
      if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error("planner_max_steps_invalid");
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("planner_max_attempts_invalid");

      const timestamp = now();
      const steps: PlanStep[] = [];
      let previous: string | undefined;
      const seenGoals = new Set<SubGoal>();
      for (const subGoal of intent.subGoals) {
        if (seenGoals.has(subGoal) || subGoal === "request_human_approval") continue;
        seenGoals.add(subGoal);
        const step = createStep(subGoal, previous, intent, maxAttempts, context.availableCapabilities ?? options.availableCapabilities);
        steps.push(step);
        previous = step.id;
      }

      if (steps.length === 0) {
        const fallback = fallbackSubGoal(intent);
        const step = createStep(fallback, previous, intent, maxAttempts, context.availableCapabilities ?? options.availableCapabilities);
        steps.push(step);
        previous = step.id;
      }

      if (intent.riskProfile.requiresHumanApproval && !steps.some((step) => step.risk === "irreversible")) {
        const finalStep: PlanStep = {
          id: "final-submit",
          objective: "final_submit",
          owner: "application",
          status: "pending",
          dependsOn: previous === undefined ? [] : [previous],
          inputRefs: [intent.intentId],
          outputRefs: [],
          attempt: 0,
          maxAttempts: 1,
          acceptanceCriteria: ["human approval is current and payload is unchanged"],
          risk: "irreversible",
          capabilityNames: ["final_submit"]
        };
        steps.push(finalStep);
      }

      if (steps.length > maxSteps) throw new Error("planner_step_budget_exceeded");
      const assumptions = assumptionsFor(intent);
      const approvalPoints: ApprovalPoint[] = steps.flatMap((step): ApprovalPoint[] => {
        if (step.risk === "irreversible") {
          return [{ id: `approval:${step.id}`, kind: "final_submit" as const, stepId: step.id, required: true }];
        }
        if (step.risk === "high") {
          return [{ id: `approval:${step.id}`, kind: "high_risk_action" as const, stepId: step.id, required: true }];
        }
        return [];
      });
      const plan = PlanStateSchema.parse({
        planId: `plan:${idFactory()}`,
        intentId: intent.intentId,
        revision: 1,
        steps,
        assumptions,
        approvalPoints,
        estimatedCost: {
          steps: steps.length,
          toolCalls: steps.reduce((count, step) => count + (step.capabilityNames?.length ?? 0), 0),
          tokens: 0,
          durationMs: steps.length * 1_000
        },
        createdAt: timestamp,
        updatedAt: timestamp
      });
      return plan;
    }
  };
}

function createStep(
  subGoal: SubGoal,
  previous: string | undefined,
  intent: CanonicalIntent,
  maxAttempts: number,
  availableCapabilities: readonly string[] | undefined
): PlanStep {
  const owner = ownerForSubGoal(subGoal);
  const risk = riskForSubGoal(subGoal, intent);
  const id = `${subGoal.replaceAll("_", "-")}-${intent.revision}-${previous === undefined ? 1 : previous.length + 1}`;
  const capability = capabilityForSubGoal(subGoal, availableCapabilities);
  return {
    id,
    objective: subGoal,
    owner,
    status: "pending",
    dependsOn: previous === undefined ? [] : [previous],
    inputRefs: [intent.intentId],
    outputRefs: [`output:${id}`],
    attempt: 0,
    maxAttempts: risk === "irreversible" ? 1 : maxAttempts,
    acceptanceCriteria: acceptanceCriteriaFor(subGoal),
    risk,
    ...(capability === undefined ? {} : { capabilityNames: [capability] })
  };
}

function ownerForSubGoal(subGoal: SubGoal): PlanStepOwner {
  switch (subGoal) {
    case "select_latest_resume":
    case "select_resume":
    case "analyze_resume":
    case "update_resume_profile":
      return "resume";
    case "identify_target_job":
    case "analyze_job":
    case "match_resume_to_job":
      return "job_matching";
    case "prepare_application":
    case "fill_application":
    case "verify_application":
    case "submit_application":
    case "track_application":
      return "application";
    case "review_result":
      return "review";
    case "request_human_approval":
      return "review";
  }
}

function riskForSubGoal(subGoal: SubGoal, intent: CanonicalIntent): PlanRisk {
  if (subGoal === "submit_application") return "irreversible";
  if (subGoal === "fill_application" || subGoal === "verify_application" || intent.riskProfile.level === "high") {
    return "high";
  }
  return "low";
}

function capabilityForSubGoal(subGoal: SubGoal, available: readonly string[] | undefined): string | undefined {
  const candidate = subGoal === "submit_application"
    ? "final_submit"
    : subGoal === "fill_application" || subGoal === "verify_application"
      ? "application.reversible_act"
      : undefined;
  if (candidate === undefined) return undefined;
  return available === undefined || available.includes(candidate) ? candidate : undefined;
}

function acceptanceCriteriaFor(subGoal: SubGoal): string[] {
  switch (subGoal) {
    case "select_latest_resume":
    case "select_resume":
      return ["selected resume reference exists"];
    case "identify_target_job":
      return ["target job reference is explicit"];
    case "analyze_job":
    case "match_resume_to_job":
      return ["requirements have evidence references"];
    case "prepare_application":
      return ["application draft contains only supported facts"];
    case "fill_application":
      return ["filled fields pass readback validation"];
    case "verify_application":
      return ["review snapshot and target identity are current"];
    case "submit_application":
      return ["human approval is current and payload is unchanged"];
    case "review_result":
      return ["review decision is recorded"];
    default:
      return [`${subGoal} completed`];
  }
}

function assumptionsFor(intent: CanonicalIntent): PlanAssumption[] {
  return Object.entries(intent.entities)
    .filter(([, field]) => field.source === "model_inference")
    .slice(0, 100)
    .map(([field, value]) => ({
      id: `assumption:${field}`,
      statement: `${field} is inferred and must be confirmed before irreversible actions`,
      source: "inference" as const,
      confidence: value.confidence,
      invalidationConditions: [`user corrects ${field}`, `evidence for ${field} changes`]
    }));
}

function fallbackSubGoal(intent: CanonicalIntent): SubGoal {
  switch (intent.primaryGoal) {
    case "analyze_resume": return "analyze_resume";
    case "analyze_job": return "analyze_job";
    case "match_resume_to_job": return "match_resume_to_job";
    case "prepare_application": return "prepare_application";
    case "fill_application": return "fill_application";
    case "submit_application": return "submit_application";
    case "track_application": return "track_application";
    case "update_resume_profile": return "update_resume_profile";
  }
}
