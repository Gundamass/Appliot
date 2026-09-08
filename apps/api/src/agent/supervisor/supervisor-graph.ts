import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { createHash } from "node:crypto";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { z } from "zod";
import {
  BudgetStateSchema,
  BudgetLimitsSchema,
  PlanStateSchema,
  PlanApprovalBindingSchema,
  CanonicalIntentSchema,
  RuntimeHumanInterruptSchema,
  RuntimeHumanResumeSchema,
  SupervisorDecisionSchema,
  type CanonicalIntent,
  type BudgetLimits,
  type BudgetState,
  type JsonValue,
  type PlanState,
  type PlanStep,
  type RuntimeHumanInterrupt,
  type RuntimeHumanResume,
  type SupervisorDecision
} from "@resume/contracts";
import type { CapabilityCatalog } from "../capabilities/catalog.js";
import type { CallerAttestationToken } from "../policy/caller-attestation.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import type { PolicyDecision } from "../policy/policy-engine.js";
import type { TraceSink } from "../trace-sink.js";
import type { Planner } from "./planner.js";
import type { PlanValidator } from "./plan-validator.js";
import type { PlanValidationResult } from "./plan-validator.js";
import type { Replanner } from "./replanner.js";
import type { Supervisor } from "./supervisor.js";
import type { EvidenceStore } from "../observations/evidence-store.js";

export interface SpecialistExecutionInput {
  readonly runId: string;
  readonly intent: CanonicalIntent;
  readonly plan: PlanState;
  readonly step: PlanStep;
  readonly decision: Extract<SupervisorDecision, { type: "dispatch_agent" }>;
  readonly executionEpoch: number;
  readonly attemptToken: string;
  readonly signal: AbortSignal;
  readonly humanResume?: RuntimeHumanResume;
  /** Issued for the specialist-agent boundary by the trusted root. */
  readonly callerAttestation?: CallerAttestationToken;
}

export interface SpecialistExecutionResult {
  readonly status: "completed" | "blocked" | "failed";
  readonly outputRef?: string;
  readonly evidenceRefs?: readonly string[];
  readonly satisfiedCriteria?: readonly string[];
  readonly toolCallsUsed?: number;
  readonly tokensUsed?: number;
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
  plan?: PlanState | undefined;
  decision?: SupervisorDecision | undefined;
  currentStepId?: string | undefined;
  approvedStepId?: string | undefined;
  approvedPlanRevision?: number | undefined;
  approvedExecutionEpoch?: number | undefined;
  executionEpoch: number;
  status: "running" | "interrupted" | "completed" | "blocked" | "failed" | "cancelled";
  pendingInterrupt?: RuntimeHumanInterrupt | undefined;
  evidenceRefs: string[];
  iteration: number;
  budget: BudgetState;
  startedAt?: string | undefined;
  error?: { code: string; message: string } | undefined;
}

export const SupervisorGraphStateSchema = z.object({
  runId: z.string().min(1).max(128),
  intent: CanonicalIntentSchema,
  plan: PlanStateSchema.optional(),
  decision: SupervisorDecisionSchema.optional(),
  currentStepId: z.string().min(1).max(128).optional(),
  approvedStepId: z.string().min(1).max(128).optional(),
  approvedPlanRevision: z.number().int().positive().optional(),
  approvedExecutionEpoch: z.number().int().nonnegative().optional(),
  executionEpoch: z.number().int().nonnegative(),
  status: z.enum(["running", "interrupted", "completed", "blocked", "failed", "cancelled"]),
  pendingInterrupt: RuntimeHumanInterruptSchema.optional(),
  evidenceRefs: z.array(z.string().min(1).max(128)).max(500),
  iteration: z.number().int().nonnegative(),
  budget: BudgetStateSchema,
  startedAt: z.string().datetime().optional(),
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
  /** Issued by the trusted composition root; never derived from model output. */
  readonly callerAttestation?: CallerAttestationToken;
  /** Separate from the graph token; never reuse a graph identity for agents. */
  readonly specialistCallerAttestation?: CallerAttestationToken;
  readonly checkpointer?: BaseCheckpointSaver;
  readonly executionEpoch?: number;
  readonly now?: () => string;
  readonly traceSink?: TraceSink;
  readonly traceTaskId?: (state: SupervisorGraphState) => string;
  readonly budgetLimits?: Partial<BudgetLimits>;
  readonly evidenceRefValidator?: (ref: string) => boolean;
  /** Authoritative action/invocation provenance for completion evidence. */
  readonly evidenceStore?: EvidenceStore;
  /** Trusted provider for current snapshot/target/payload approval bindings. */
  readonly approvalBindingProvider?: (input: {
    readonly runId: string;
    readonly intent: CanonicalIntent;
    readonly plan: PlanState;
    readonly step: PlanStep;
    readonly evidenceRefs: readonly string[];
    readonly interrupt: RuntimeHumanInterrupt;
  }) => Promise<unknown> | unknown;
  readonly maxIterations?: number;
}

const replace = <T>(_left: T, right: T): T => right;
const appendUnique = (left: string[], right: string[]): string[] => [...new Set([...left, ...right])];
const defaultBudget = (): BudgetState => ({
  steps: 0,
  toolCalls: 0,
  retries: 0,
  replans: 0,
  tokens: 0,
  elapsedMs: 0
});

const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxAttemptsPerStep: 2,
  maxRetries: 64,
  maxReplans: 8,
  maxSteps: 32,
  maxToolCalls: 64,
  maxTokens: 100_000,
  maxDurationMs: 15 * 60 * 1_000
};

export const SupervisorGraphStateAnnotation = Annotation.Root({
  runId: Annotation<string>,
  intent: Annotation<CanonicalIntent>,
  plan: Annotation<PlanState | undefined>({ reducer: replace, default: () => undefined }),
  decision: Annotation<SupervisorDecision | undefined>({ reducer: replace, default: () => undefined }),
  currentStepId: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  approvedStepId: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  approvedPlanRevision: Annotation<number | undefined>({ reducer: replace, default: () => undefined }),
  approvedExecutionEpoch: Annotation<number | undefined>({ reducer: replace, default: () => undefined }),
  startedAt: Annotation<string | undefined>({ reducer: replace, default: () => undefined }),
  executionEpoch: Annotation<number>({ reducer: replace, default: () => 0 }),
  status: Annotation<SupervisorGraphState["status"]>({ reducer: replace, default: () => "running" }),
  pendingInterrupt: Annotation<RuntimeHumanInterrupt | undefined>({ reducer: replace, default: () => undefined }),
  evidenceRefs: Annotation<string[]>({ reducer: appendUnique, default: () => [] }),
  iteration: Annotation<number>({ reducer: replace, default: () => 0 }),
  budget: Annotation<BudgetState>({ reducer: replace, default: defaultBudget }),
  error: Annotation<SupervisorGraphState["error"]>({ reducer: replace, default: () => undefined })
});

export type SupervisorGraphStateUpdate = typeof SupervisorGraphStateAnnotation.Update;

export function createSupervisorGraph(dependencies: SupervisorGraphDependencies) {
  const humanResumes = new Map<string, RuntimeHumanResume>();
  const budgetLimits = BudgetLimitsSchema.parse({ ...DEFAULT_BUDGET_LIMITS, ...(dependencies.budgetLimits ?? {}) });
  const maxIterations = dependencies.maxIterations ?? 32;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error("supervisor_max_iterations_invalid");
  }

  const graph = new StateGraph(SupervisorGraphStateAnnotation)
    .addNode("planning", async (state) => {
      const now = dependencies.now ?? (() => new Date().toISOString());
      const startedAt = state.startedAt ?? now();
      const elapsedBudget = withElapsed(state.budget, startedAt, now());
      const budgetError = budgetExceeded(elapsedBudget, budgetLimits);
      if (budgetError !== undefined) {
        emitTrace(dependencies, state, "planning", "safety_block", "blocked", budgetError);
        return failure("budget_exceeded", new Error(budgetError), "blocked");
      }
      let rawPlan: unknown = state.plan;
      if (rawPlan === undefined) {
        try {
          rawPlan = await dependencies.planner.create(state.intent);
        } catch (error) {
          return failure("planner_failed", error);
        }
      }
      const result = dependencies.planValidator.validate(rawPlan);
      if (!acceptsUnboundApprovalPlan(result)) {
        emitTrace(dependencies, state, "planning", "safety_block", "blocked", "plan_invalid");
        return failure("plan_invalid", new Error(result.errors.map((item) => item.code).join(",")), "blocked");
      }
      if (result.plan.intentId !== state.intent.intentId) {
        emitTrace(dependencies, state, "planning", "safety_block", "blocked", "plan_intent_mismatch");
        return failure("plan_intent_mismatch", undefined, "blocked");
      }
      const estimatedCostError = estimatedCostExceeded(result.plan.estimatedCost, budgetLimits);
      if (estimatedCostError !== undefined) {
        emitTrace(dependencies, state, "planning", "safety_block", "blocked", estimatedCostError);
        return failure("budget_exceeded", new Error(estimatedCostError), "blocked");
      }
      emitTrace(dependencies, state, "planning", "node", "planned", "plan_validated");
      return {
        plan: result.plan,
        executionEpoch: dependencies.executionEpoch ?? state.executionEpoch,
        startedAt,
        budget: elapsedBudget,
        status: "running" as const
      };
    })
    .addNode("supervising", async (state) => {
      if (state.plan === undefined) return failure("plan_missing");
      if (state.iteration >= maxIterations) return failure("supervisor_iteration_limit");
      const now = dependencies.now ?? (() => new Date().toISOString());
      const elapsedBudget = withElapsed(state.budget, state.startedAt, now());
      const budgetError = budgetExceeded(elapsedBudget, budgetLimits);
      if (budgetError !== undefined) {
        emitTrace(dependencies, state, "supervising", "safety_block", "blocked", budgetError);
        return failure("budget_exceeded", new Error(budgetError), "blocked");
      }
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
      const resumedStep = state.approvedStepId === readyStep.id
        && state.approvedPlanRevision === state.plan.revision
        && state.approvedExecutionEpoch === state.executionEpoch
        ? state.approvedStepId
        : undefined;
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
            executionEpoch: state.executionEpoch
          }));
        } catch (error) {
          return failure("supervisor_decision_invalid", error);
        }
      }
      const bindingError = decisionBindingError(decision, readyStep, state.intent, state.plan);
      if (bindingError !== undefined) {
        emitTrace(dependencies, state, "supervising", "safety_block", "blocked", bindingError);
        return failure(bindingError, undefined, "blocked");
      }
      emitTrace(
        dependencies,
        state,
        "supervising",
        "model_decision",
        "selected",
        decision.type === "dispatch_agent" ? "dispatch" : decision.type === "invoke_tool" ? "invoke_tool" : decision.type
      );
      return {
        decision,
        currentStepId: readyStep?.id,
        iteration: state.iteration + 1,
        budget: elapsedBudget,
        status: "running" as const
      };
    })
    .addNode("routing", async (state) => {
      const decision = state.decision;
      if (decision === undefined) return failure("decision_missing");
      if (decision.type === "ask_human") {
        const step = state.currentStepId === undefined
          ? undefined
          : state.plan?.steps.find((candidate) => candidate.id === state.currentStepId);
        let interrupt = decision.interrupt;
        if ((interrupt.reason === "final_submit" || interrupt.reason === "high_risk_action")
          && (step?.risk === "irreversible" || step?.risk === "high")) {
          if (step === undefined || state.plan === undefined) {
            return failure("approval_binding_invalid", undefined, "blocked");
          }
          if (dependencies.approvalBindingProvider === undefined) {
            return failure("approval_binding_provider_missing", undefined, "blocked");
          }
          try {
            const provided = await dependencies.approvalBindingProvider({
              runId: state.runId,
              intent: state.intent,
              plan: state.plan,
              step,
              evidenceRefs: interrupt.evidenceRefs,
              interrupt
            });
            const binding = PlanApprovalBindingSchema.parse(provided);
            const boundPlan = PlanStateSchema.parse({
              ...state.plan,
              steps: state.plan.steps.map((candidate) => candidate.id === step.id ? { ...candidate, approvalBinding: binding } : candidate)
            });
            const proposed = readRecord(interrupt.proposedAction) ?? {};
            interrupt = RuntimeHumanInterruptSchema.parse({
              ...interrupt,
              proposedAction: {
                ...proposed,
                runId: state.runId,
                stepId: step.id,
                planRevision: state.plan.revision,
                executionEpoch: state.executionEpoch,
                snapshotId: binding.snapshotId,
                targetFingerprint: binding.targetFingerprint,
                payloadHash: binding.payloadHash
              }
            });
            const bindingError = approvalInterruptBindingError({ ...state, plan: boundPlan }, interrupt, boundPlan.steps.find((candidate) => candidate.id === step.id));
            if (bindingError !== undefined) return failure(bindingError, undefined, "blocked");
            emitTrace(dependencies, state, "routing", "interrupt", "pending", interrupt.reason);
            return {
              plan: boundPlan,
              status: "interrupted" as const,
              pendingInterrupt: interrupt
            };
          } catch (error) {
            return failure("approval_binding_invalid", error, "blocked");
          }
        }
        const bindingError = approvalInterruptBindingError(state, interrupt, step);
        if (bindingError !== undefined) {
          emitTrace(dependencies, state, "routing", "safety_block", "blocked", bindingError);
          return failure(bindingError, undefined, "blocked");
        }
        emitTrace(dependencies, state, "routing", "interrupt", "pending", decision.interrupt.reason);
        return {
          status: "interrupted" as const,
          pendingInterrupt: RuntimeHumanInterruptSchema.parse(interrupt)
        };
      }
      if (decision.type === "finish") {
        if (state.plan?.steps.some((step) => step.status === "pending" || step.status === "running")) {
          return failure("plan_incomplete", undefined, "blocked");
        }
        if (decision.outcome === "completed") {
          const completionError = completionValidation(state, dependencies.evidenceRefValidator, dependencies.evidenceStore);
          if (completionError !== undefined) {
            emitTrace(dependencies, state, "routing", "safety_block", "blocked", completionError);
            return failure(completionError, undefined, "blocked");
          }
        }
        emitTrace(dependencies, state, "routing", "node", decision.outcome, "complete");
        return { status: decision.outcome, error: undefined };
      }
      if (decision.type === "fail") {
        emitTrace(dependencies, state, "routing", "safety_block", decision.retryable ? "blocked" : "failed", decision.code);
        return failure(decision.code, undefined, decision.retryable ? "blocked" : "failed");
      }
      return { status: "running" as const };
    })
    .addNode("claiming", async (state) => {
      const plan = state.plan;
      const step = state.currentStepId === undefined
        ? undefined
        : plan?.steps.find((candidate) => candidate.id === state.currentStepId);
      if (plan === undefined || state.decision === undefined || step === undefined) {
        return failure("execution_context_missing");
      }
      if (state.decision.type !== "dispatch_agent" && state.decision.type !== "invoke_tool") {
        return failure("decision_not_executable");
      }
      if (step.status !== "pending") {
        return failure("execution_claim_invalid", undefined, "blocked");
      }
      if (step.attempt >= step.maxAttempts || step.attempt >= budgetLimits.maxAttemptsPerStep) {
        return failure("step_attempt_exhausted", undefined, "blocked");
      }
      const attempt = step.attempt + 1;
      const expectedAttemptToken = makeAttemptToken(state.runId, plan.planId, plan.revision, step.id, attempt);
      if (step.attemptToken !== undefined && step.attemptToken !== expectedAttemptToken) {
        emitTrace(dependencies, state, "claiming", "safety_block", "blocked", "attempt_token_invalid");
        return failure("attempt_token_invalid", undefined, "blocked");
      }
      const attemptToken = expectedAttemptToken;
      const now = dependencies.now ?? (() => new Date().toISOString());
      const nextBudget = {
        ...withElapsed(state.budget, state.startedAt, now()),
        steps: state.budget.steps + 1,
        toolCalls: state.budget.toolCalls + (state.decision.type === "invoke_tool" ? 1 : 0)
      };
      const budgetError = budgetExceeded(nextBudget, budgetLimits);
      if (budgetError !== undefined) {
        emitTrace(dependencies, state, "claiming", "safety_block", "blocked", budgetError);
        return failure("budget_exceeded", new Error(budgetError), "blocked");
      }
      const updatedPlan = PlanStateSchema.parse({
        ...plan,
        steps: plan.steps.map((candidate) => candidate.id !== step.id
          ? candidate
          : { ...candidate, status: "running", attempt, attemptToken }),
        updatedAt: now()
      });
      return {
        plan: updatedPlan,
        budget: nextBudget,
        status: "running" as const
      };
    })
    .addNode("human_gate", async (state) => {
      const pending = state.pendingInterrupt;
      if (pending === undefined) return failure("interrupt_missing");
      const resume = RuntimeHumanResumeSchema.parse(interrupt(pending));
      if (resume.interruptId !== pending.interruptId) return failure("interrupt_mismatch");
      const now = dependencies.now ?? (() => new Date().toISOString());
      if (resume.action === "confirm"
        && approvalExpired(pending.expiresAt, now())) {
        return failure("approval_expired", undefined, "blocked");
      }
      if ((pending.reason === "final_submit" || pending.reason === "high_risk_action")
        && !["confirm", "reject", "cancel"].includes(resume.action)) {
        return failure("approval_action_invalid", undefined, "blocked");
      }
      if (["prompt_injection", "captcha", "ambiguous_fact", "authentication"].includes(pending.reason)
        && !["correct", "reject", "cancel"].includes(resume.action)) {
        return failure("human_gate_action_invalid", undefined, "blocked");
      }
      if (resume.action === "cancel") return { status: "cancelled" as const, pendingInterrupt: undefined };
      if (resume.action === "reject") return { status: "blocked" as const, pendingInterrupt: undefined };
      if (resume.action === "correct") {
        const step = state.currentStepId === undefined
          ? undefined
          : state.plan?.steps.find((candidate) => candidate.id === state.currentStepId);
        if (dependencies.replanner === undefined || state.plan === undefined || step === undefined) {
          emitTrace(dependencies, state, "human_gate", "safety_block", "blocked", "human_correction_requires_replan");
          return failure("human_correction_requires_replan", undefined, "blocked");
        }
        try {
          const nextPlan = await dependencies.replanner.replan(state.plan, {
            reason: "human_correction",
            failedStepId: step.id,
            observationRefs: correctionRefs(resume.values),
            preservedOutputRefs: step.outputRefs
          });
          const validation = dependencies.planValidator.validate(nextPlan);
          if (!acceptsUnboundApprovalPlan(validation)) {
            return failure("replan_invalid", undefined, "blocked");
          }
          const replanError = replanBindingError(validation.plan, state.plan, state.intent);
          if (replanError !== undefined) return failure(replanError, undefined, "blocked");
          const budget = {
            ...withElapsed(state.budget, state.startedAt, now()),
            replans: state.budget.replans + 1
          };
          const budgetError = budgetExceeded(budget, budgetLimits);
          if (budgetError !== undefined) return failure("budget_exceeded", new Error(budgetError), "blocked");
          emitTrace(dependencies, state, "human_gate", "node", "replanned", "human_correction");
          return {
            plan: validation.plan,
            status: "running" as const,
            pendingInterrupt: undefined,
            decision: undefined,
            currentStepId: undefined,
            approvedStepId: undefined,
            approvedPlanRevision: undefined,
            approvedExecutionEpoch: undefined,
            budget
          };
        } catch (error) {
          return failure("replan_failed", error, "blocked");
        }
      }
      humanResumes.set(state.runId, resume);
      emitTrace(dependencies, state, "human_gate", "checkpoint", "approved", "confirm");
      return {
        status: "running" as const,
        pendingInterrupt: undefined,
        approvedStepId: state.currentStepId,
        approvedPlanRevision: state.plan?.revision,
        approvedExecutionEpoch: state.executionEpoch
      };
    })
    .addNode("executing", async (state) => {
      const plan = state.plan;
      const decision = state.decision;
      const step = state.currentStepId === undefined
        ? undefined
        : plan?.steps.find((candidate) => candidate.id === state.currentStepId);
      if (plan === undefined || decision === undefined || step === undefined) return failure("execution_context_missing");
      if (step.status !== "running" || step.attemptToken === undefined) {
        return failure("execution_attempt_missing", undefined, "blocked");
      }
      const expectedAttemptToken = makeAttemptToken(state.runId, plan.planId, plan.revision, step.id, step.attempt);
      if (step.attemptToken !== expectedAttemptToken) {
        return failure("attempt_token_invalid", undefined, "blocked");
      }
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
            executionEpoch: state.executionEpoch,
            attemptToken: step.attemptToken,
            signal: controller.signal,
            ...(resume === undefined ? {} : { humanResume: resume }),
            ...(dependencies.specialistCallerAttestation === undefined
              ? {}
              : { callerAttestation: dependencies.specialistCallerAttestation })
          });
        } else if (decision.type === "invoke_tool") {
          if (dependencies.catalog === undefined) return failure("capability_catalog_unavailable", undefined, "blocked");
          if (dependencies.policy === undefined) return failure("capability_policy_unavailable", undefined, "blocked");
          const descriptor = dependencies.catalog.describe(decision.capability);
          const idempotencyKey = descriptor?.idempotency === "keyed"
            ? step.attemptToken ?? `${state.runId}:${plan.revision}:${step.id}:${step.attempt}`
            : undefined;
          emitTrace(dependencies, state, "executing", "tool_call", "dispatch", decision.capability);
          let authorization: PolicyDecision;
          try {
            authorization = await dependencies.policy.authorize({
              caller: "graph",
              capability: decision.capability,
              input: decision.input,
              context: {
                runId: state.runId,
                planRevision: plan.revision,
                executionEpoch: state.executionEpoch,
                ...(step.approvalBinding === undefined ? {} : {
                  snapshotId: step.approvalBinding.snapshotId,
                  targetFingerprint: step.approvalBinding.targetFingerprint,
                  payloadHash: step.approvalBinding.payloadHash
                }),
                callerAttestation: dependencies.callerAttestation,
                ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
                ...(resume?.values.approval === undefined ? {} : { approval: resume.values.approval })
              }
            });
          } catch (error) {
            emitTrace(dependencies, state, "executing", "tool_call", "failed", "tool_authorization_exception");
            throw error;
          }
          if (!authorization.allowed) {
            emitTrace(dependencies, state, "executing", "tool_call", "denied", `policy_${authorization.reason}`);
            return failure(`policy_${authorization.reason}`, undefined, "blocked");
          }
          emitTrace(dependencies, state, "executing", "tool_call", "permit", decision.capability);
          let rawResult: unknown;
          try {
            rawResult = await dependencies.catalog.invoke(decision.capability, authorization.input, {
              caller: "graph",
              callerAttestation: dependencies.callerAttestation,
              runId: state.runId,
              executionEpoch: state.executionEpoch,
              signal: controller.signal,
              permit: authorization.permit,
              ...(idempotencyKey === undefined ? {} : { idempotencyKey })
            });
          } catch (error) {
            emitTrace(dependencies, state, "executing", "tool_call", "failed", "tool_invoke_exception");
            throw error;
          }
          result = capabilityExecutionResult(rawResult);
          emitTrace(
            dependencies,
            state,
            "executing",
            "tool_call",
            result.status === "completed" ? "complete" : "failed",
            result.errorCode ?? decision.capability
          );
        } else {
          return failure("decision_not_executable");
        }
      } catch (error) {
        return failure("execution_failed", error, "failed");
      } finally {
        humanResumes.delete(state.runId);
      }
      const executionBudget = {
        ...withElapsed(state.budget, state.startedAt, (dependencies.now ?? (() => new Date().toISOString()))()),
        toolCalls: state.budget.toolCalls + (result.toolCallsUsed ?? 0),
        tokens: state.budget.tokens + (result.tokensUsed ?? 0)
      };
      const executionBudgetError = budgetExceeded(executionBudget, budgetLimits);
      if (executionBudgetError !== undefined) {
        emitTrace(dependencies, state, "executing", "safety_block", "blocked", executionBudgetError);
        return failure("budget_exceeded", new Error(executionBudgetError), "blocked");
      }
      if (result.status === "completed") {
        if (dependencies.evidenceRefValidator === undefined) {
          emitTrace(dependencies, state, "executing", "safety_block", "blocked", "evidence_ref_validator_missing");
          return failure("evidence_ref_validator_missing", undefined, "blocked");
        }
        const evidenceRefs = [...new Set(result.evidenceRefs ?? [])];
        const evidenceError = validateStepEvidenceRefs(
          evidenceRefs,
          state,
          step,
          dependencies.evidenceRefValidator,
          dependencies.evidenceStore
        );
        if (evidenceError !== undefined) return failure(evidenceError, undefined, "blocked");
        if (evidenceRefs.length === 0) return failure("step_evidence_required", undefined, "blocked");
        const satisfiedCriteria = [...new Set(result.satisfiedCriteria ?? [])];
        if (!step.acceptanceCriteria.every((criterion) => satisfiedCriteria.includes(criterion))) {
          return failure("acceptance_criteria_unsatisfied", undefined, "blocked");
        }
        emitTrace(dependencies, state, "executing", "node", "completed", "complete");
        const updatedPlan = PlanStateSchema.parse({
          ...plan,
          steps: plan.steps.map((candidate) => candidate.id !== step.id
            ? candidate
            : {
              ...candidate,
              status: "completed",
              attempt: Math.max(candidate.attempt, 1),
              ...(result.outputRef === undefined || isSyntheticOutputRef(result.outputRef)
                ? {}
                : { outputRefs: [...new Set([...candidate.outputRefs, result.outputRef])] }),
              completionEvidenceRefs: evidenceRefs,
              satisfiedCriteria
            }),
          updatedAt: (dependencies.now ?? (() => new Date().toISOString()))()
        });
        return {
          plan: updatedPlan,
          status: "running" as const,
          decision: undefined,
          currentStepId: undefined,
          approvedStepId: undefined,
          approvedPlanRevision: undefined,
          approvedExecutionEpoch: undefined,
          evidenceRefs,
          budget: executionBudget
        };
      }
      if (result.retryable === true && step.attempt < step.maxAttempts) {
        const nextBudget = {
          ...executionBudget,
          retries: executionBudget.retries + 1
        };
        const retryBudgetError = budgetExceeded(nextBudget, budgetLimits);
        if (retryBudgetError !== undefined) return failure("budget_exceeded", new Error(retryBudgetError), "blocked");
        const retryPlan = PlanStateSchema.parse({
          ...plan,
          steps: plan.steps.map((candidate) => candidate.id !== step.id
            ? candidate
            : { ...candidate, status: "pending" as const, attemptToken: undefined }),
          updatedAt: (dependencies.now ?? (() => new Date().toISOString()))()
        });
        emitTrace(dependencies, state, "executing", "node", "retrying", "retryable_failure");
        return {
          plan: retryPlan,
          status: "running" as const,
          decision: undefined,
          currentStepId: undefined,
          approvedStepId: undefined,
          approvedPlanRevision: undefined,
          approvedExecutionEpoch: undefined,
          budget: nextBudget
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
          if (acceptsUnboundApprovalPlan(validation)) {
            const replanError = replanBindingError(validation.plan, plan, state.intent);
            if (replanError !== undefined) return failure(replanError, undefined, "blocked");
            const budget = { ...executionBudget, replans: executionBudget.replans + 1 };
            const budgetError = budgetExceeded(budget, budgetLimits);
            if (budgetError !== undefined) return failure("budget_exceeded", new Error(budgetError), "blocked");
            emitTrace(dependencies, state, "executing", "node", "replanned", "replan");
            return {
              plan: validation.plan,
              status: "running" as const,
              decision: undefined,
              currentStepId: undefined,
              approvedStepId: undefined,
              approvedPlanRevision: undefined,
              approvedExecutionEpoch: undefined,
              budget
            };
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
      return "claiming";
    }, { human_gate: "human_gate", claiming: "claiming", [END]: END })
    .addConditionalEdges("claiming", (state) => state.status === "running" ? "executing" : END, {
      executing: "executing",
      [END]: END
    })
    .addConditionalEdges("human_gate", (state) => state.status === "running" ? "supervising" : END, { supervising: "supervising", [END]: END })
    .addConditionalEdges("executing", (state) => {
      if (state.status !== "running") return END;
      return "supervising";
    }, { supervising: "supervising", [END]: END })
    .compile(dependencies.checkpointer === undefined ? {} : { checkpointer: dependencies.checkpointer });
  const invoke = graph.invoke.bind(graph);
  return new Proxy(graph, {
    get(target, property, receiver) {
      if (property !== "invoke") return Reflect.get(target, property, receiver);
      return async (input: unknown, ...args: unknown[]) => {
        const initial = readRecord(input);
        if (initial !== undefined && "runId" in initial && "intent" in initial) {
          const parsed = SupervisorGraphStateSchema.safeParse({
            executionEpoch: dependencies.executionEpoch ?? 0,
            status: "running",
            evidenceRefs: [],
            iteration: 0,
            budget: defaultBudget(),
            ...initial
          });
          if (!parsed.success || untrustedInitialState(initial)
            || parsed.data.plan?.steps.some((step) => step.status === "completed" && step.attempt === 0)) {
            return { ...(parsed.success ? parsed.data : initial), ...failure("invalid_initial_state", undefined, "blocked") };
          }
        }
        return Reflect.apply(invoke, undefined, [input, ...args]);
      };
    }
  });
}

function nextReadyStep(plan: PlanState): PlanStep | undefined {
  const completed = new Set(plan.steps.filter((step) => step.status === "completed" || step.status === "skipped").map((step) => step.id));
  return plan.steps.find((step) => step.status === "pending" && step.dependsOn.every((dependency) => completed.has(dependency)));
}

function acceptsUnboundApprovalPlan(
  result: PlanValidationResult
): result is PlanValidationResult & { plan: PlanState } {
  return result.plan !== undefined
    && (result.valid || result.errors.every((error) => error.code === "approval_binding_missing"));
}

function untrustedInitialState(initial: Record<string, unknown>): boolean {
  if ("status" in initial && initial.status !== undefined && initial.status !== "running") return true;
  if ("evidenceRefs" in initial) {
    const refs = initial.evidenceRefs;
    if (!Array.isArray(refs) || refs.length > 0) return true;
  }
  if ("iteration" in initial && initial.iteration !== undefined && initial.iteration !== 0) return true;
  if ("executionEpoch" in initial && initial.executionEpoch !== undefined && initial.executionEpoch !== 0) return true;
  if ("startedAt" in initial && initial.startedAt !== undefined) return true;
  if ("plan" in initial || "decision" in initial || "currentStepId" in initial
    || "approvedStepId" in initial || "approvedPlanRevision" in initial
    || "approvedExecutionEpoch" in initial || "pendingInterrupt" in initial || "error" in initial) return true;
  if ("budget" in initial) {
    const budget = readRecord(initial.budget);
    const defaults = defaultBudget();
    if (budget === undefined || Object.entries(defaults).some(([metric, value]) => budget[metric] !== value)) return true;
  }
  return false;
}

function estimatedCostExceeded(
  estimatedCost: PlanState["estimatedCost"],
  limits: BudgetLimits
): string | undefined {
  const checks: Array<[string, number, number | undefined]> = [
    ["steps_exceeded", estimatedCost.steps, limits.maxSteps],
    ["tool_calls_exceeded", estimatedCost.toolCalls, limits.maxToolCalls],
    ["tokens_exceeded", estimatedCost.tokens, limits.maxTokens],
    ["duration_exceeded", estimatedCost.durationMs, limits.maxDurationMs]
  ];
  return checks.find(([, value, limit]) => limit !== undefined && value > limit)?.[0];
}

function capabilityExecutionResult(raw: unknown): SpecialistExecutionResult {
  const value = readRecord(raw);
  if (value === undefined) return { status: "failed", errorCode: "capability_result_invalid" };
  const status = value.status;
  if (status !== undefined && status !== "completed" && status !== "blocked" && status !== "failed") {
    return { status: "failed", errorCode: "capability_result_invalid" };
  }
  const evidenceRefs = value.evidenceRefs;
  const satisfiedCriteria = value.satisfiedCriteria;
  return {
    status: status === "blocked" || status === "failed" ? status : "completed",
    ...(typeof value.outputRef === "string" ? { outputRef: value.outputRef } : {}),
    ...(Array.isArray(evidenceRefs) && evidenceRefs.every((ref): ref is string => typeof ref === "string") ? { evidenceRefs } : {}),
    ...(Array.isArray(satisfiedCriteria) && satisfiedCriteria.every((criterion): criterion is string => typeof criterion === "string") ? { satisfiedCriteria } : {}),
    ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
    ...(value.retryable === true ? { retryable: true } : {})
  };
}

function makeAttemptToken(runId: string, planId: string, revision: number, stepId: string, attempt: number): string {
  const raw = `attempt:${runId}:${planId}:${revision}:${stepId}:${attempt}`;
  if (raw.length < 256) return raw;
  return `attempt:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

function decisionBindingError(
  decision: SupervisorDecision,
  step: PlanStep,
  intent: CanonicalIntent,
  plan: PlanState
): string | undefined {
  if (decision.type !== "dispatch_agent" && decision.type !== "invoke_tool") return undefined;
  const input = readRecord(decision.input);
  if (input?.stepId !== step.id) return "decision_step_mismatch";
  if (input?.intentId !== intent.intentId) return "decision_intent_mismatch";
  if (input?.planRevision !== plan.revision) return "decision_plan_revision_mismatch";
  if (!sameStringArray(input?.inputRefs, step.inputRefs)) return "decision_input_refs_mismatch";
  if (decision.type === "dispatch_agent" && decision.agent !== `${step.owner}_agent`) {
    return "decision_agent_mismatch";
  }
  if (decision.type === "invoke_tool" && !step.capabilityNames?.includes(decision.capability)) {
    return "capability_step_mismatch";
  }
  if ((step.risk === "high" || step.risk === "irreversible") && decision.type === "dispatch_agent") {
    return "specialist_direct_risk_forbidden";
  }
  if (step.risk === "irreversible"
    && (decision.type !== "invoke_tool" || decision.capability !== "final_submit")) {
    return "irreversible_capability_mismatch";
  }
  return undefined;
}

function approvalInterruptBindingError(
  state: { runId: string; executionEpoch: number; plan: PlanState | undefined },
  interruptValue: RuntimeHumanInterrupt,
  step: PlanStep | undefined
): string | undefined {
  if (interruptValue.reason !== "final_submit" && interruptValue.reason !== "high_risk_action") return undefined;
  if (step === undefined || state.plan === undefined) return "approval_binding_invalid";
  const proposed = readRecord(interruptValue.proposedAction);
  if (proposed === undefined
    || proposed.runId !== state.runId
    || proposed.stepId !== step.id
    || proposed.planRevision !== state.plan.revision
    || proposed.executionEpoch !== state.executionEpoch) {
    return "approval_binding_invalid";
  }
  if (step.risk === "irreversible") {
    if (step.approvalBinding === undefined
      || proposed.snapshotId !== step.approvalBinding.snapshotId
      || proposed.targetFingerprint !== step.approvalBinding.targetFingerprint
      || proposed.payloadHash !== step.approvalBinding.payloadHash) {
      return "approval_binding_invalid";
    }
  } else if (step.approvalBinding !== undefined && (
    proposed.snapshotId !== step.approvalBinding.snapshotId
    || proposed.targetFingerprint !== step.approvalBinding.targetFingerprint
    || proposed.payloadHash !== step.approvalBinding.payloadHash
  )) {
    return "approval_binding_invalid";
  }
  return undefined;
}

function approvalExpired(expiresAt: string, now: string): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  return !Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs) || expiresAtMs <= nowMs;
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function isSyntheticOutputRef(value: string): boolean {
  return /^output:[^/\\]+$/u.test(value);
}

function validateEvidenceRefs(
  refs: readonly string[],
  validator: ((ref: string) => boolean) | undefined
): string | undefined {
  if (refs.some((ref) => ref.length === 0 || isSyntheticOutputRef(ref) || validator !== undefined && !validator(ref))) {
    return "evidence_ref_invalid";
  }
  return undefined;
}

function validateStepEvidenceRefs(
  refs: readonly string[],
  state: SupervisorGraphState,
  step: PlanStep,
  validator: ((ref: string) => boolean) | undefined,
  evidenceStore: EvidenceStore | undefined
): string | undefined {
  const basicError = validateEvidenceRefs(refs, validator);
  if (basicError !== undefined) return basicError;
  if (evidenceStore === undefined) return undefined;
  for (const ref of refs) {
    const result = evidenceStore.validate(ref, { runId: state.runId, stepId: step.id });
    if (!result.valid) return result.reason;
  }
  return undefined;
}

function completionValidation(
  state: SupervisorGraphState,
  validator: ((ref: string) => boolean) | undefined,
  evidenceStore: EvidenceStore | undefined
): string | undefined {
  if (state.evidenceRefs.length === 0) return "evidence_required_for_completion";
  if (validator === undefined && evidenceStore === undefined) return "evidence_ref_validator_missing";
  const evidenceError = validator === undefined
    ? state.evidenceRefs.some((ref) => !evidenceStore!.has(ref)) ? "evidence_not_registered" : undefined
    : validateEvidenceRefs(state.evidenceRefs, validator);
  if (evidenceError !== undefined) return evidenceError;
  for (const step of state.plan?.steps ?? []) {
    if (step.status !== "completed") continue;
    const refs = step.completionEvidenceRefs ?? [];
    if (refs.length === 0) return "step_evidence_required";
    const refsError = evidenceStore === undefined
      ? validateEvidenceRefs(refs, validator)
      : validateStepEvidenceRefs(refs, state, step, validator, evidenceStore);
    if (refsError !== undefined) return refsError;
    const criteria = step.satisfiedCriteria ?? [];
    if (!step.acceptanceCriteria.every((criterion) => criteria.includes(criterion))) {
      return "acceptance_criteria_unsatisfied";
    }
  }
  return undefined;
}

function replanBindingError(next: PlanState, current: PlanState, intent: CanonicalIntent): string | undefined {
  if (next.intentId !== intent.intentId) return "replan_intent_mismatch";
  if (next.planId !== current.planId) return "replan_plan_id_mismatch";
  if (next.revision !== current.revision + 1) return "replan_revision_mismatch";
  if (next.previousRevision !== current.revision) return "replan_previous_revision_mismatch";
  const history = next.revisionHistory;
  if (history === undefined || history.length === 0) return "replan_revision_history_invalid";
  for (let index = 1; index < history.length; index += 1) {
    if (history[index]!.revision !== history[index - 1]!.revision + 1) {
      return "replan_revision_history_invalid";
    }
  }
  const latest = history.at(-1);
  if (latest?.revision !== current.revision
    || latest.planRef !== `plan:${current.planId}:${current.revision}`) {
    return "replan_revision_history_invalid";
  }
  const previousHistory = current.revisionHistory ?? [];
  const expectedHistoryLength = Math.min(100, previousHistory.length + 1);
  if (history.length !== expectedHistoryLength) return "replan_revision_history_invalid";
  const preserved = history.slice(0, -1);
  const expectedPreserved = previousHistory.slice(-preserved.length);
  if (preserved.length !== expectedPreserved.length
    || preserved.some((entry, index) => entry.revision !== expectedPreserved[index]!.revision
      || entry.planRef !== expectedPreserved[index]!.planRef)) {
    return "replan_revision_history_invalid";
  }
  return undefined;
}

function correctionRefs(values: Readonly<Record<string, JsonValue>>): string[] {
  return [...new Set(Object.entries(values)
    .filter(([key, value]) => /(?:ref|evidence|observation)/iu.test(key) && typeof value === "string")
    .map(([, value]) => value as string))]
    .filter((ref) => !isSyntheticOutputRef(ref))
    .slice(0, 100);
}

function withElapsed(budget: BudgetState, startedAt: string | undefined, now: string): BudgetState {
  if (startedAt === undefined) return { ...budget };
  const startedMs = Date.parse(startedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs)) return { ...budget };
  return { ...budget, elapsedMs: Math.max(budget.elapsedMs, Math.max(0, nowMs - startedMs)) };
}

function budgetExceeded(budget: BudgetState, limits: Partial<BudgetLimits> | undefined): string | undefined {
  if (limits === undefined) return undefined;
  const checks: Array<[string, number, number | undefined]> = [
    ["steps_exceeded", budget.steps, limits.maxSteps],
    ["tool_calls_exceeded", budget.toolCalls, limits.maxToolCalls],
    ["replans_exceeded", budget.replans, limits.maxReplans],
    ["retries_exceeded", budget.retries, limits.maxRetries],
    ["tokens_exceeded", budget.tokens, limits.maxTokens],
    ["duration_exceeded", budget.elapsedMs, limits.maxDurationMs]
  ];
  return checks.find(([, value, limit]) => limit !== undefined && value > limit)?.[0];
}

function emitTrace(
  dependencies: SupervisorGraphDependencies,
  state: SupervisorGraphState,
  node: string,
  kind: "node" | "tool_call" | "model_decision" | "interrupt" | "checkpoint" | "safety_block",
  outcome: string,
  reasonCode: string
): void {
  try {
    dependencies.traceSink?.record({
      runId: state.runId,
      taskId: dependencies.traceTaskId?.(state) ?? state.runId,
      node,
      kind,
      outcome,
      reasonCode
    });
  } catch {
    // Observability must never turn a safe execution into an unsafe one.
  }
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
