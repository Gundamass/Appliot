import {
  ObservationRefSchema,
  PlanStateSchema,
  ReplanRequestSchema,
  type ObservationRef,
  type PlanState,
  type ReplanRequest
} from "@resume/contracts";

export interface ReplanInput extends Omit<ReplanRequest, "observationRefs" | "preservedOutputRefs"> {
  readonly observationRefs?: readonly string[];
  readonly preservedOutputRefs?: readonly string[];
  readonly observations?: readonly ObservationRef[];
}

export interface Replanner {
  replan(plan: PlanState, request: ReplanInput): Promise<PlanState>;
}

export interface ReplannerOptions {
  readonly now?: () => string;
}

const INVALIDATING_REASONS = new Set([
  "target_page_changed",
  "stale_snapshot",
  "job_data_changed",
  "user_changed",
  "risk_changed",
  "failed_prerequisite",
  "retry_exhausted"
]);

export function createReplanner(options: ReplannerOptions = {}): Replanner {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async replan(rawPlan, rawRequest) {
      const plan = PlanStateSchema.parse(rawPlan);
      const request = normalizeRequest(rawRequest);
      const observations = collectObservationRefs(rawRequest.observations, request.observationRefs);
      const preservedOutputRefs = request.preservedOutputRefs;
      const failedStepId = request.failedStepId ?? inferInvalidatedStep(plan, request.reason);
      const invalidated = failedStepId === undefined
        ? new Set(plan.steps.filter((step) => step.status !== "completed").map((step) => step.id))
        : dependentClosure(plan, failedStepId);
      const timestamp = now();
      const previousRevisionRef = {
        revision: plan.revision,
        planRef: `plan:${plan.planId}:${plan.revision}`,
        reason: request.reason,
        createdAt: timestamp
      };
      const revisionHistory = [...(plan.revisionHistory ?? []), previousRevisionRef].slice(-100);
      const steps = plan.steps.map((step) => {
        if (!invalidated.has(step.id) || step.status === "completed") return { ...step, dependsOn: [...step.dependsOn], inputRefs: [...step.inputRefs], outputRefs: [...step.outputRefs] };
        const inputRefs = [...new Set([...step.inputRefs, ...observations])].slice(-100);
        const outputRefs = preservedOutputRefs.length > 0
          ? [...new Set([...step.outputRefs, ...preservedOutputRefs])].slice(-100)
          : [...step.outputRefs];
        return {
          ...step,
          status: "pending" as const,
          attempt: 0,
          dependsOn: [...step.dependsOn],
          inputRefs,
          outputRefs
        };
      });
      return PlanStateSchema.parse({
        ...plan,
        revision: plan.revision + 1,
        previousRevision: plan.revision,
        steps,
        revisionHistory,
        createdAt: plan.createdAt,
        updatedAt: timestamp
      });
    }
  };
}

function normalizeRequest(rawRequest: ReplanInput): ReplanRequest {
  return ReplanRequestSchema.parse({
    reason: rawRequest.reason,
    ...(rawRequest.failedStepId === undefined ? {} : { failedStepId: rawRequest.failedStepId }),
    observationRefs: rawRequest.observationRefs ?? rawRequest.observations?.map((observation) => observation.id) ?? [],
    preservedOutputRefs: rawRequest.preservedOutputRefs ?? []
  });
}

function collectObservationRefs(observations: readonly ObservationRef[] | undefined, refs: readonly string[]): string[] {
  const parsed = (observations ?? []).map((observation) => ObservationRefSchema.parse(observation).id);
  return [...new Set([...refs, ...parsed])].slice(-100);
}

function inferInvalidatedStep(plan: PlanState, reason: string): string | undefined {
  if (!INVALIDATING_REASONS.has(reason)) return undefined;
  return plan.steps.find((step) => step.status === "running" || step.status === "blocked" || step.status === "pending")?.id;
}

function dependentClosure(plan: PlanState, root: string): Set<string> {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  if (!byId.has(root)) throw new Error("replan_failed_step_unknown");
  const invalidated = new Set<string>([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of plan.steps) {
      if (!invalidated.has(step.id) && step.dependsOn.some((dependency) => invalidated.has(dependency))) {
        invalidated.add(step.id);
        changed = true;
      }
    }
  }
  return invalidated;
}
