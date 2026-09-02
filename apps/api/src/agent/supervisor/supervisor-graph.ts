import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { z } from "zod";
import {
  PlanStateSchema,
  CanonicalIntentSchema,
  RuntimeHumanInterruptSchema,
  RuntimeHumanResumeSchema,
  SupervisorDecisionSchema,
  type CanonicalIntent,
  type PlanState,
  type PlanStep,
  type RuntimeHumanInterrupt,
  type RuntimeHumanResume,
  type SupervisorDecision
} from "@resume/contracts";
import type { CapabilityCatalog } from "../capabilities/catalog.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import type { Planner } from "./planner.js";
import type { PlanValidator } from "./plan-validator.js";
import type { Replanner } from "./replanner.js";
import type { Supervisor } from "./supervisor.js";

export interface SpecialistExecutionInput {
  readonly runId: string;
  readonly intent: CanonicalIntent;
  readonly plan: PlanState;
  readonly step: PlanStep;
  readonly decision: Extract<SupervisorDecision, { type: "dispatch_agent" }>;
  readonly executionEpoch: number;
  readonly signal: AbortSignal;
  readonly humanResume?: RuntimeHumanResume;
}

export interface SpecialistExecutionResult {
  readonly status: "completed" | "blocked" | "failed";
  readonly outputRef?: string;
  readonly evidenceRefs?: readonly string[];
  readonly errorCode?: string;
  readonly retryable?: boolean;
}

export interface SpecialistAgent {
  execute(input: SpecialistExecutionInput): Promise<SpecialistExecutionResult> | SpecialistExecutionResult;
}

export type SpecialistAgentRegistry = Readonly<Record<string, SpecialistAgent>>;

export interface SupervisorGraphState {
  runId: string;
  intent: CanonicalIntent;
  plan?: PlanState;
  decision?: SupervisorDecision;
  currentStepId?: string;
  approvedStepId?: string;
  status: "running" | "interrupted" | "completed" | "blocked" | "failed" | "cancelled";
  pendingInterrupt?: RuntimeHumanInterrupt;
  evidenceRefs: string[];
  iteration: number;
  error?: { code: string; message: string };
}

export const SupervisorGraphStateSchema = z.object({
  runId: z.string().min(1).max(128),
  intent: CanonicalIntentSchema,
  plan: PlanStateSchema.optional(),
  decision: SupervisorDecisionSchema.optional(),
  currentStepId: z.string().min(1).max(128).optional(),
  approvedStepId: z.string().min(1).max(128).optional(),
  status: z.enum(["running", "interrupted", "completed", "blocked", "failed", "cancelled"]),
  pendingInterrupt: RuntimeHumanInterruptSchema.optional(),
  evidenceRefs: z.array(z.string().min(1).max(128)).max(500),
  iteration: z.number().int().nonnegative(),
  error: z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(2_000) }).strict().optional()
}).strict();

export interface SupervisorGraphDependencies {
  readonly planner: Planner;
  readonly supervisor: Supervisor;
  readonly planValidator: PlanValidator;
  readonly replanner?: Replanner;
  readonly agents?: SpecialistAgentRegistry;
  readonly catalog?: CapabilityCatalog;
  readonly policy?: PolicyEngine;
  readonly checkpointer?: BaseCheckpointSaver;
  readonly executionEpoch?: number;
  readonly maxIterations?: number;
}

const replace = <T>(_left: T, right: T): T => right;
const appendUnique = (left: string[], right: string[]): string[] => [...new Set([...left, ...right])];

export const SupervisorGraphStateAnnotation = Annotation.Root({
  runId: Annotation<string>,
  intent: Annotation<CanonicalIntent>,
  plan: Annotation<PlanState | undefined>({ reducer: replace, default: () => undefined }),
  decision: Annotation<SupervisorDecision | undefined>({ reducer: replace, default: () => undefined }),
  currentStepId: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  approvedStepId: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  status: Annotation<SupervisorGraphState["status"]>({ reducer: replace, default: () => "running" }),
  pendingInterrupt: Annotation<RuntimeHumanInterrupt | undefined>({ reducer: replace, default: () => undefined }),
  evidenceRefs: Annotation<string[]>({ reducer: appendUnique, default: () => [] }),
  iteration: Annotation<number>({ reducer: replace, default: () => 0 }),
  error: Annotation<SupervisorGraphState["error"]>({ reducer: replace, default: () => undefined })
});

export type SupervisorGraphStateUpdate = typeof SupervisorGraphStateAnnotation.Update;

export function createSupervisorGraph(dependencies: SupervisorGraphDependencies) {
  const humanResumes = new Map<string, RuntimeHumanResume>();
  const maxIterations = dependencies.maxIterations ?? 32;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error("supervisor_max_iterations_invalid");
  }

  const graph = new StateGraph(SupervisorGraphStateAnnotation)
    .addNode("planning", async (state) => {
      let rawPlan: unknown = state.plan;
      if (rawPlan === undefined) {
        try {
          rawPlan = await dependencies.planner.create(state.intent);
        } catch (error) {
          return failure("planner_failed", error);
        }
      }
      const result = dependencies.planValidator.validate(rawPlan);
      if (!result.valid || result.plan === undefined) {
        return failure("plan_invalid", new Error(result.errors.map((item) => item.code).join(",")));
      }
      if (result.plan.intentId !== state.intent.intentId) {
        return failure("plan_intent_mismatch", undefined, "blocked");
      }
      return { plan: result.plan, status: "running" as const };
    })
    .addNode("supervising", async (state) => {
      if (state.plan === undefined) return failure("plan_missing");
      if (state.iteration >= maxIterations) return failure("supervisor_iteration_limit");
      const readyStep = nextReadyStep(state.plan);
      if (readyStep === undefined) {
        if (state.plan.steps.some((step) => step.status === "pending" || step.status === "running")) {
          return failure("plan_deadlock", undefined, "blocked");
        }
        return {
          decision: SupervisorDecisionSchema.parse({
            type: "finish",
            outcome: "completed",
            summary: "all plan steps are terminal"
          }),
          iteration: state.iteration + 1,
          status: "running" as const
        };
      }
      let decision: SupervisorDecision;
      const resumedStep = state.approvedStepId === readyStep.id ? state.approvedStepId : undefined;
      if (resumedStep !== undefined && readyStep !== undefined) {
        decision = approvedDecision(state.intent, state.plan, readyStep);
      } else {
        try {
          decision = SupervisorDecisionSchema.parse(await dependencies.supervisor.decide({
            state,
            runId: state.runId,
            intent: state.intent,
            plan: state.plan,
            readyStep,
            evidenceRefs: state.evidenceRefs,
            executionEpoch: dependencies.executionEpoch ?? 0
          }));
        } catch (error) {
          return failure("supervisor_decision_invalid", error);
        }
      }
      const bindingError = decisionBindingError(decision, readyStep);
      if (bindingError !== undefined) return failure(bindingError, undefined, "blocked");
      return {
        decision,
        currentStepId: readyStep?.id,
        iteration: state.iteration + 1,
        status: "running" as const
      };
    })
    .addNode("routing", async (state) => {
      const decision = state.decision;
      if (decision === undefined) return failure("decision_missing");
      if (decision.type === "ask_human") {
        return {
          status: "interrupted" as const,
          pendingInterrupt: RuntimeHumanInterruptSchema.parse(decision.interrupt)
        };
      }
      if (decision.type === "finish") {
        if (state.plan?.steps.some((step) => step.status === "pending" || step.status === "running")) {
          return failure("plan_incomplete", undefined, "blocked");
        }
        if (decision.outcome === "completed" && state.evidenceRefs.length === 0) {
          return failure("evidence_required_for_completion", undefined, "blocked");
        }
        return { status: decision.outcome, error: undefined };
      }
      if (decision.type === "fail") {
        return failure(decision.code, undefined, decision.retryable ? "blocked" : "failed");
      }
      return { status: "running" as const };
    })
    .addNode("human_gate", async (state) => {
      const pending = state.pendingInterrupt;
      if (pending === undefined) return failure("interrupt_missing");
      const resume = RuntimeHumanResumeSchema.parse(interrupt(pending));
      if (resume.interruptId !== pending.interruptId) return failure("interrupt_mismatch");
      if (resume.action === "cancel") return { status: "cancelled" as const, pendingInterrupt: undefined };
      if (resume.action === "reject") return { status: "blocked" as const, pendingInterrupt: undefined };
      humanResumes.set(state.runId, resume);
      return {
        status: "running" as const,
        pendingInterrupt: undefined,
        approvedStepId: state.currentStepId
      };
    })
    .addNode("executing", async (state) => {
      const plan = state.plan;
      const decision = state.decision;
      const step = state.currentStepId === undefined
        ? undefined
        : plan?.steps.find((candidate) => candidate.id === state.currentStepId);
      if (plan === undefined || decision === undefined || step === undefined) return failure("execution_context_missing");
      const controller = new AbortController();
      const resume = humanResumes.get(state.runId);
      let result: SpecialistExecutionResult;
      try {
        if (decision.type === "dispatch_agent") {
          const agent = dependencies.agents?.[decision.agent];
          if (agent === undefined) return failure("agent_unavailable", undefined, "blocked");
          result = await agent.execute({
            runId: state.runId,
            intent: state.intent,
            plan,
            step,
            decision,
            executionEpoch: dependencies.executionEpoch ?? 0,
            signal: controller.signal,
            ...(resume === undefined ? {} : { humanResume: resume })
          });
        } else if (decision.type === "invoke_tool") {
          if (dependencies.catalog === undefined) return failure("capability_catalog_unavailable", undefined, "blocked");
          if (dependencies.policy === undefined) return failure("capability_policy_unavailable", undefined, "blocked");
          const descriptor = dependencies.catalog.describe(decision.capability);
          const idempotencyKey = descriptor?.idempotency === "keyed"
            ? `${state.runId}:${plan.revision}:${step.id}`
            : undefined;
          const authorization = await dependencies.policy.authorize({
            caller: "graph",
            capability: decision.capability,
            input: decision.input,
            context: {
              runId: state.runId,
              planRevision: plan.revision,
              executionEpoch: dependencies.executionEpoch ?? 0,
              ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
              ...(resume?.values.approval === undefined ? {} : { approval: resume.values.approval })
            }
          });
          if (!authorization.allowed) return failure(`policy_${authorization.reason}`, undefined, "blocked");
          await dependencies.catalog.invoke(decision.capability, authorization.input, {
            caller: "graph",
            runId: state.runId,
            executionEpoch: dependencies.executionEpoch ?? 0,
            signal: controller.signal,
            permit: authorization.permit,
            ...(idempotencyKey === undefined ? {} : { idempotencyKey })
          });
          result = { status: "completed", outputRef: `output:${step.id}` };
        } else {
          return failure("decision_not_executable");
        }
      } catch (error) {
        return failure("execution_failed", error, "failed");
      } finally {
        humanResumes.delete(state.runId);
      }
      if (result.status === "completed") {
        const updatedPlan = PlanStateSchema.parse({
          ...plan,
          steps: plan.steps.map((candidate) => candidate.id !== step.id
            ? candidate
            : {
              ...candidate,
              status: "completed",
              attempt: Math.min(candidate.attempt + 1, candidate.maxAttempts),
              outputRefs: result.outputRef === undefined ? candidate.outputRefs : [...new Set([...candidate.outputRefs, result.outputRef])]
            }),
          updatedAt: new Date().toISOString()
        });
        return {
          plan: updatedPlan,
          status: "running" as const,
          decision: undefined,
          currentStepId: undefined,
          approvedStepId: undefined,
          evidenceRefs: result.evidenceRefs === undefined ? [] : [...result.evidenceRefs]
        };
      }
      if (dependencies.replanner !== undefined && (result.retryable === true || result.status === "blocked")) {
        try {
          const nextPlan = await dependencies.replanner.replan(plan, {
            reason: result.errorCode ?? "execution_blocked",
            failedStepId: step.id,
            observationRefs: result.evidenceRefs ?? [],
            preservedOutputRefs: step.outputRefs
          });
          const validation = dependencies.planValidator.validate(nextPlan);
          if (validation.valid && validation.plan !== undefined) {
            return { plan: validation.plan, status: "running" as const, decision: undefined, currentStepId: undefined };
          }
          return failure("replan_invalid", undefined, "blocked");
        } catch (error) {
          return failure("replan_failed", error, "blocked");
        }
      }
      return failure(result.errorCode ?? "execution_blocked", undefined, result.status === "blocked" ? "blocked" : "failed");
    })
    .addConditionalEdges(START, () => "planning")
    .addConditionalEdges("planning", (state) => state.status === "running" ? "supervising" : END, {
      supervising: "supervising",
      [END]: END
    })
    .addConditionalEdges("supervising", (state) => state.status === "running" ? "routing" : END, {
      routing: "routing",
      [END]: END
    })
    .addConditionalEdges("routing", (state) => {
      if (state.status === "interrupted") return "human_gate";
      if (state.status !== "running") return END;
      return "executing";
    }, { human_gate: "human_gate", executing: "executing", [END]: END })
    .addConditionalEdges("human_gate", (state) => state.status === "running" ? "supervising" : END, { supervising: "supervising", [END]: END })
    .addConditionalEdges("executing", (state) => {
      if (state.status !== "running") return END;
      return "supervising";
    }, { supervising: "supervising", [END]: END })
    .compile(dependencies.checkpointer === undefined ? {} : { checkpointer: dependencies.checkpointer });
  return graph;
}

function nextReadyStep(plan: PlanState): PlanStep | undefined {
  const completed = new Set(plan.steps.filter((step) => step.status === "completed" || step.status === "skipped").map((step) => step.id));
  return plan.steps.find((step) => step.status === "pending" && step.dependsOn.every((dependency) => completed.has(dependency)));
}

function decisionBindingError(decision: SupervisorDecision, step: PlanStep): string | undefined {
  if (decision.type !== "dispatch_agent" && decision.type !== "invoke_tool") return undefined;
  const input = readRecord(decision.input);
  if (input?.stepId !== step.id) return "decision_step_mismatch";
  if (decision.type === "invoke_tool" && !step.capabilityNames?.includes(decision.capability)) {
    return "capability_step_mismatch";
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function approvedDecision(
  intent: CanonicalIntent,
  plan: PlanState,
  step: PlanStep
): SupervisorDecision {
  const input = {
    stepId: step.id,
    intentId: intent.intentId,
    planRevision: plan.revision,
    inputRefs: step.inputRefs
  };
  const capability = step.capabilityNames?.[0];
  return capability === undefined
    ? SupervisorDecisionSchema.parse({
      type: "dispatch_agent",
      agent: `${step.owner}_agent`,
      input,
      reason: "human approval received"
    })
    : SupervisorDecisionSchema.parse({
      type: "invoke_tool",
      capability,
      input,
      reason: "human approval received"
    });
}

function failure(code: string, error?: unknown, status: "failed" | "blocked" = "failed") {
  return {
    status,
    error: { code, message: error instanceof Error ? error.message : code },
    pendingInterrupt: undefined
  } as const;
}
