import { randomUUID } from "node:crypto";
import { Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { z } from "zod";
import {
  AgentRunInputSchema,
  AgentRunResultSchema,
  CanonicalIntentSchema,
  EvidenceRefSchema,
  IntentResolutionSchema,
  PlanStateSchema,
  PlanStepSchema,
  RuntimeHumanResumeSchema,
  RuntimeHumanInterruptSchema,
  SupervisorDecisionSchema,
  type AgentRunInput,
  type AgentRunResult,
  type CanonicalIntent,
  type ClarificationRequest,
  type EvidenceRef,
  type JsonValue,
  type PlanState,
  type PlanStep,
  type RuntimeHumanInterrupt,
  type RuntimeHumanResume,
  type SupervisorDecision
} from "@resume/contracts";
import type { IntentContext } from "../intent/intent-context.js";
import type { IntentResolver } from "../intent/intent-resolver.js";
import { createClarificationManager } from "../intent/clarification-manager.js";
import { BudgetExceededError, createBudgetManager, type BudgetManager } from "./budget-manager.js";
import type { CancellationManager } from "./cancellation-manager.js";
import { CHECKPOINT_VERSION, type RuntimeCheckpointStore } from "./checkpoint-store.js";
import {
  RuntimeGraphStateAnnotation,
  RuntimeGraphStateSchema,
  type RuntimeGraphState,
  type RuntimeGraphStateUpdate,
  type RuntimeArtifactStore,
  type RuntimeState,
  stateHash,
  toRuntimeGraphState
} from "./runtime-state.js";

export interface RuntimePlanner {
  create(intent: CanonicalIntent, input?: AgentRunInput, runtime?: RuntimeOperationContext): Promise<PlanState> | PlanState;
}

export interface RuntimeOperationContext {
  signal: AbortSignal;
  executionEpoch: number;
}

export interface RuntimeExecutorInput {
  runId: string;
  step: PlanStep;
  intent: CanonicalIntent;
  plan: PlanState;
  decision: Extract<SupervisorDecision, { type: "dispatch_agent" | "invoke_tool" }>;
  humanResume?: RuntimeHumanResume | undefined;
  signal: AbortSignal;
  executionEpoch: number;
}

export interface RuntimeExecutorResult {
  status: "completed" | "blocked" | "failed";
  outputRef?: string | undefined;
  evidenceRefs?: EvidenceRef[] | undefined;
  toolCallsUsed?: number | undefined;
  tokensUsed?: number | undefined;
  errorCode?: string | undefined;
  retryable?: boolean | undefined;
}

export const RuntimeExecutorResultSchema = z.object({
  status: z.enum(["completed", "blocked", "failed"]),
  outputRef: z.string().min(1).max(256).optional(),
  evidenceRefs: z.array(EvidenceRefSchema).max(500).optional(),
  toolCallsUsed: z.number().int().nonnegative().optional(),
  tokensUsed: z.number().int().nonnegative().optional(),
  errorCode: z.string().regex(/^[a-z0-9_:-]{1,120}$/u).optional(),
  retryable: z.boolean().optional()
}).strict();

export interface RuntimeExecutor {
  execute(input: RuntimeExecutorInput): Promise<RuntimeExecutorResult> | RuntimeExecutorResult;
}

export interface RuntimeSupervisorInput {
  state: RuntimeState;
  readyStep?: PlanStep;
  signal: AbortSignal;
  executionEpoch: number;
}

export interface RuntimeSupervisor {
  decide(input: RuntimeSupervisorInput): Promise<SupervisorDecision> | SupervisorDecision;
}

export interface ExecutionLoopDependencies {
  intentResolver: IntentResolver;
  planner: RuntimePlanner;
  executor: RuntimeExecutor;
  checkpointStore: RuntimeCheckpointStore;
  artifactStore: RuntimeArtifactStore;
  cancellationManager: CancellationManager;
  supervisor?: RuntimeSupervisor;
  langGraphCheckpointer?: BaseCheckpointSaver;
  clarificationManager?: ReturnType<typeof createClarificationManager>;
  idFactory?: () => string;
  now?: () => string;
  intentContext?: (input: AgentRunInput) => IntentContext;
}

export interface ExecutionLoop {
  start(state: RuntimeState): Promise<RuntimeState>;
  resume(runId: string, input: RuntimeHumanResume): Promise<RuntimeState>;
  cancel(runId: string): Promise<RuntimeState>;
  state(runId: string): RuntimeState | undefined;
  adopt(state: RuntimeState): void;
}

const terminalStatuses = new Set(["completed", "blocked", "failed", "cancelled", "expired"]);

class ExecutionSupersededError extends Error {
  constructor() {
    super("agent_execution_epoch_stale");
    this.name = "ExecutionSupersededError";
  }
}

export function createExecutionLoop(dependencies: ExecutionLoopDependencies): ExecutionLoop {
  const idFactory = dependencies.idFactory ?? randomUUID;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const clarificationManager = dependencies.clarificationManager ?? createClarificationManager();
  const states = new Map<string, RuntimeState>();
  const budgets = new Map<string, BudgetManager>();
  const running = new Map<string, Promise<RuntimeState>>();
  const locks = new Map<string, Promise<void>>();
  const resumeInFlight = new Set<string>();
  // LangGraph persists Command resume values as pending writes. Keep the
  // actual human answer outside the graph and pass only a one-shot opaque
  // reference through the checkpointer.
  const resumeValues = new Map<string, RuntimeHumanResume>();

  const graph = new StateGraph(RuntimeGraphStateAnnotation)
    .addNode("intent", async (graphState) => runNode(graphState, "intent", async (state) => {
      const input = state.input;
      if (input === undefined) return fail(state, "runtime_input_missing", "intent");
      updateElapsed(state);
      const runtimeContext = operationContext(state);
      const rawResolution = await runWithDeadline(state, runtimeContext, (operation) =>
        dependencies.intentResolver.resolve(
          { text: input.goal, messageId: `run:${state.runId}` },
          dependencies.intentContext?.(input),
          operation
        )
      );
      updateElapsed(state);
      assertActiveEpoch(state, runtimeContext.executionEpoch);
      let resolution: ReturnType<typeof IntentResolutionSchema.parse>;
      try {
        resolution = IntentResolutionSchema.parse(rawResolution);
      } catch {
        return fail(state, "runtime_intent_resolution_invalid", "intent");
      }
      if (resolution.type === "rejected") return fail(state, resolution.reason, "intent");

      const intent = CanonicalIntentSchema.parse(resolution.intent);
      state.intent = intent;
      state.intentRef = dependencies.artifactStore.saveIntent(intent);
      state.evidenceRefs = [...intent.evidenceRefs];
      if (resolution.type === "needs_clarification") {
        state.pendingInterrupt = clarificationInterrupt(intent, resolution.question, now, idFactory);
        state.status = "interrupted";
        state.phase = "human_gate";
        return persist(state);
      }
      state.status = "running";
      state.phase = "plan";
      return persist(state);
    }))
    .addNode("plan", async (graphState) => runNode(graphState, "plan", async (state) => {
      if (state.intent === undefined) return fail(state, "runtime_intent_missing", "plan");
      updateElapsed(state);
      const runtimeContext = operationContext(state);
      const rawPlan = await runWithDeadline(state, runtimeContext, (operation) =>
        dependencies.planner.create(state.intent!, state.input, operation)
      );
      updateElapsed(state);
      assertActiveEpoch(state, runtimeContext.executionEpoch);
      const plan = PlanStateSchema.parse(rawPlan);
      if (plan.intentId !== state.intent.intentId) return fail(state, "runtime_plan_intent_mismatch", "plan");
      const planError = validatePlan(plan);
      if (planError !== undefined) return fail(state, planError, "plan");
      if ((state.intent.riskProfile.requiresHumanApproval || hasIrreversibleStep(plan))
        && !hasRequiredApprovalPoint(plan)) {
        return fail(state, "runtime_plan_approval_missing", "plan");
      }
      state.plan = plan;
      state.planRef = dependencies.artifactStore.savePlan(plan);
      state.phase = "dispatch";
      state.status = "running";
      return persist(state);
    }))
    .addNode("dispatch", async (graphState) => runNode(graphState, "dispatch", async (state) => {
      if (state.plan === undefined || state.intent === undefined) return fail(state, "runtime_plan_missing", "dispatch");
      assertActive(state);
      updateElapsed(state);
      const readyStep = nextStep(state.plan);
      if (readyStep === undefined) {
        state.status = "completed";
        state.phase = "complete";
        state.summary = "计划中的步骤已完成";
        return persist(state);
      }
      consumeStep(state);
      state.currentStepId = readyStep.id;
      const runtimeContext = operationContext(state);
      const rawDecision = await runWithDeadline(state, runtimeContext, (operation) =>
        (dependencies.supervisor ?? createDefaultSupervisor({ idFactory, now })).decide({
          state,
          readyStep,
          ...operation
        })
      );
      updateElapsed(state);
      const decision = SupervisorDecisionSchema.parse(rawDecision);
      assertActiveEpoch(state, runtimeContext.executionEpoch);
      if (readyStep.risk === "irreversible" && decision.type !== "ask_human") {
        return fail(state, "runtime_approval_required", "dispatch");
      }
      state.lastDecision = decision;
      if (decision.type === "ask_human") {
        const pending = sanitizeInterrupt(decision.interrupt);
        if (readyStep.risk === "irreversible" && !approvalBindingMatches(pending, state, readyStep)) {
          return fail(state, "runtime_approval_binding_invalid", "dispatch");
        }
        state.pendingInterrupt = pending;
        state.status = "interrupted";
        state.phase = "human_gate";
        return persist(state);
      }
      if (decision.type === "finish") {
        if (decision.outcome === "completed") return fail(state, "runtime_supervisor_finish_not_allowed", "dispatch");
        state.status = decision.outcome;
        state.phase = "blocked";
        state.summary = decision.summary;
        return persist(state);
      }
      if (decision.type === "fail") return fail(state, decision.code, "dispatch", decision.retryable);
      if (decision.type === "dispatch_agent" || decision.type === "invoke_tool") {
        markStepRunning(state.plan, readyStep.id);
        savePlan(state);
        state.phase = "wait";
        state.status = "running";
        return persist(state);
      }
      return fail(state, "runtime_decision_unhandled", "dispatch");
    }))
    .addNode("wait", async (graphState) => runNode(graphState, "wait", async (state) => {
      if (state.plan === undefined || state.intent === undefined) return fail(state, "runtime_plan_missing", "wait");
      assertActive(state);
      const decision = state.lastDecision;
      const step = state.currentStepId === undefined ? undefined : state.plan.steps.find((item) => item.id === state.currentStepId);
      if (step === undefined || decision === undefined) return fail(state, "runtime_dispatch_missing", "wait");
      if (decision.type !== "dispatch_agent" && decision.type !== "invoke_tool") {
        state.phase = "inspect";
        return persist(state);
      }
      const runtimeContext = operationContext(state);
      const remainingDuration = state.budgetLimits.maxDurationMs - state.budget.elapsedMs;
      if (remainingDuration <= 0) {
        throw new BudgetExceededError("duration", state.budget.elapsedMs, state.budgetLimits.maxDurationMs);
      }
      const deadline = createDeadlineSignal(runtimeContext.signal, remainingDuration);
      let rawResult: unknown;
      try {
        rawResult = await dependencies.executor.execute({
          runId: state.runId,
          step,
          intent: state.intent,
          plan: state.plan,
          decision,
          ...(state.transientHumanResume === undefined ? {} : { humanResume: state.transientHumanResume }),
          signal: deadline.signal,
          executionEpoch: runtimeContext.executionEpoch
        });
      } catch (error) {
        if (deadline.expired()) {
          throw new BudgetExceededError("duration", state.budgetLimits.maxDurationMs + 1, state.budgetLimits.maxDurationMs);
        }
        throw error;
      } finally {
        deadline.dispose();
      }
      assertActiveEpoch(state, runtimeContext.executionEpoch);
      if (deadline.expired()) {
        throw new BudgetExceededError("duration", state.budgetLimits.maxDurationMs + 1, state.budgetLimits.maxDurationMs);
      }
      let result: RuntimeExecutorResult;
      try {
        result = RuntimeExecutorResultSchema.parse(rawResult);
      } catch {
        return fail(state, "runtime_executor_result_invalid", "wait");
      }
      if (dependencies.cancellationManager.isCancelled(state.runId)) {
        state.status = "cancelled";
        state.phase = "cancelled";
        state.pendingInterrupt = undefined;
        state.transientHumanResume = undefined;
        state.summary = "运行已取消";
        return persist(state);
      }
      updateElapsed(state);
      if (result.evidenceRefs !== undefined) state.evidenceRefs = appendEvidenceRefs(state.evidenceRefs, result.evidenceRefs);
      const toolCallsUsed = Math.max(
        decision.type === "invoke_tool" ? 1 : 0,
        result.toolCallsUsed ?? 0
      );
      if (toolCallsUsed > 0) {
        const budget = ensureBudget(state);
        budget.consume("toolCalls", toolCallsUsed);
        state.budget = budget.snapshot();
      }
      if (result.tokensUsed !== undefined) {
        const budget = ensureBudget(state);
        budget.consume("tokens", result.tokensUsed);
        state.budget = budget.snapshot();
      }
      if (result.status === "completed") {
        if (result.outputRef !== undefined) step.outputRefs = appendRefs(step.outputRefs, [result.outputRef]);
        state.transientHumanResume = undefined;
        markStepCompleted(state.plan, step.id);
        savePlan(state);
        state.completedActionIds = appendRefs(state.completedActionIds, [`action:${step.id}:${step.attempt}`]);
        state.phase = "inspect";
        return persist(state);
      }
      if (result.status === "blocked") {
        state.transientHumanResume = undefined;
        markStepBlocked(state.plan, step.id);
        savePlan(state);
        state.status = "blocked";
        state.phase = "blocked";
        state.summary = result.errorCode ?? "步骤被阻塞";
        return persist(state);
      }
      state.transientHumanResume = undefined;
      const retryable = result.retryable ?? false;
      const maxAttempts = Math.min(step.maxAttempts, state.budgetLimits.maxAttemptsPerStep);
      if (retryable && step.attempt + 1 < maxAttempts) {
        consumeRetry(state);
        markStepPending(state.plan, step.id);
        savePlan(state);
        state.phase = "dispatch";
        return persist(state);
      }
      return fail(state, result.errorCode ?? "runtime_executor_failed", "wait", retryable);
    }))
    .addNode("inspect", async (graphState) => runNode(graphState, "inspect", async (state) => {
      updateElapsed(state);
      if (state.status === "interrupted" && state.pendingInterrupt !== undefined) {
        state.phase = "human_gate";
        return persist(state);
      }
      if (terminalStatuses.has(state.status)) return persist(state);
      if (state.plan === undefined) return fail(state, "runtime_plan_missing", "inspect");
      const unfinished = state.plan.steps.some((step) => step.status === "pending" || step.status === "running");
      if (!unfinished) {
        state.status = "completed";
        state.phase = "complete";
        state.summary = state.summary ?? "计划中的步骤已完成";
      } else {
        state.phase = "dispatch";
      }
      return persist(state);
    }))
    .addNode("human_gate", async (graphState) => runNode(graphState, "human_gate", async (state) => {
      const pending = state.pendingInterrupt ?? graphState.pendingInterrupt;
      if (pending === undefined) return fail(state, "runtime_interrupt_missing", "human_gate");
      if (state.status !== "interrupted") {
        return terminalStatuses.has(state.status)
          ? persist(state)
          : fail(state, "runtime_interrupt_state_invalid", "human_gate");
      }
      assertActive(state);
      state.pendingInterrupt = pending;
      const resumeRef = interrupt(pending);
      if (typeof resumeRef !== "string") return fail(state, "runtime_resume_ref_invalid", "human_gate");
      if (state.status !== "interrupted") {
        return terminalStatuses.has(state.status)
          ? persist(state)
          : fail(state, "runtime_interrupt_state_invalid", "human_gate");
      }
      const rawAnswer = resumeValues.get(resumeRef);
      resumeValues.delete(resumeRef);
      if (rawAnswer === undefined) return fail(state, "runtime_resume_ref_missing", "human_gate");
      assertActiveEpoch(state, state.executionEpoch + 1);
      const answer = RuntimeHumanResumeSchema.parse(rawAnswer);
      if (answer.interruptId !== pending.interruptId) return fail(state, "runtime_interrupt_mismatch", "human_gate");
      updateElapsed(state);
      if (state.budget.elapsedMs >= state.budgetLimits.maxDurationMs) {
        throw new BudgetExceededError("duration", state.budget.elapsedMs, state.budgetLimits.maxDurationMs);
      }
      if (answer.action === "cancel") {
        state.pendingInterrupt = undefined;
        state.transientHumanResume = undefined;
        state.status = "cancelled";
        state.phase = "cancelled";
        state.summary = "用户取消了运行";
        return persist(state);
      }
      if (answer.action === "reject") {
        state.pendingInterrupt = undefined;
        state.transientHumanResume = undefined;
        state.status = "blocked";
        state.phase = "blocked";
        state.summary = "用户拒绝了待确认操作";
        return persist(state);
      }

      if (pending.reason === "final_submit") {
        const step = state.currentStepId === undefined || state.plan === undefined
          ? undefined
          : state.plan.steps.find((candidate) => candidate.id === state.currentStepId);
        if (step === undefined || !approvalBindingMatches(pending, state, step)) {
          return fail(state, "runtime_approval_binding_invalid", "human_gate");
        }
        if (answer.action !== "approve") return fail(state, "runtime_approval_action_invalid", "human_gate");
      }
      if (isExpired(pending.expiresAt, now())) {
        state.pendingInterrupt = undefined;
        state.transientHumanResume = undefined;
        state.status = "expired";
        state.phase = "fail";
        state.summary = "人工确认已过期";
        return persist(state);
      }

      state.executionEpoch += 1;
      state.pendingInterrupt = undefined;
      if (pending.reason === "ambiguous_fact") {
        if (state.intent === undefined) return fail(state, "runtime_intent_missing", "human_gate");
        if (answer.action !== "confirm" && answer.action !== "correct") {
          return fail(state, "runtime_clarification_action_invalid", "human_gate");
        }
        const budget = ensureBudget(state);
        budget.consume("replans");
        state.budget = budget.snapshot();
        try {
          state.intent = clarificationManager.applyAnswer(
            state.intent,
            answer,
            clarificationRelatedFields(pending)
          );
        } catch {
          return fail(state, "runtime_clarification_answer_invalid", "human_gate");
        }
        state.intentRef = dependencies.artifactStore.saveIntent(state.intent);
        state.status = "running";
        state.phase = "plan";
      } else if (state.plan !== undefined && state.currentStepId !== undefined) {
        const step = state.plan.steps.find((candidate) => candidate.id === state.currentStepId);
        if (step === undefined) return fail(state, "runtime_step_missing", "human_gate");
        state.transientHumanResume = answer;
        markStepRunning(state.plan, state.currentStepId);
        savePlan(state);
        state.lastDecision = approvedDispatchDecision(step);
        state.status = "running";
        state.phase = "wait";
      } else {
        state.status = "running";
        state.phase = "inspect";
      }
      return persist(state);
    }))
    .addConditionalEdges(START, routeStart)
    .addConditionalEdges("intent", routeAfterIntent)
    .addConditionalEdges("plan", routeAfterPlan)
    .addConditionalEdges("dispatch", routeAfterDispatch)
    .addConditionalEdges("wait", () => "inspect")
    .addConditionalEdges("inspect", routeAfterInspect)
    .addConditionalEdges("human_gate", routeAfterHumanGate)
    .compile({ checkpointer: dependencies.langGraphCheckpointer ?? new MemorySaver() });

  const saveState = async (state: RuntimeState): Promise<RuntimeState> => {
    state.updatedAt = now();
    state.stateHash = stateHash(state);
    await dependencies.checkpointStore.save(toCheckpoint(state));
    return state;
  };

  const runGraph = async (state: RuntimeState, command?: Command): Promise<RuntimeState> => {
    states.set(state.runId, state);
    const config = { configurable: { thread_id: state.runId, checkpoint_ns: "runtime" } };
    let superseded = false;
    try {
      ensureBudget(state).assertWithin();
      if (command === undefined) {
        await graph.invoke(toRuntimeGraphState(state), config);
      } else {
        const existing = await graph.getState(config);
        if (existing === undefined || Object.keys(existing.values ?? {}).length === 0) {
          await graph.invoke(toRuntimeGraphState(state), config);
        }
        await graph.invoke(command as never, config);
      }
    } catch (error) {
      const current = states.get(state.runId) ?? state;
      if (dependencies.cancellationManager.isCancelled(state.runId)) {
        current.status = "cancelled";
        current.phase = "cancelled";
        current.pendingInterrupt = undefined;
        current.summary = "运行已取消";
      } else if (error instanceof BudgetExceededError) {
        current.status = "blocked";
        current.phase = "blocked";
        current.pendingInterrupt = undefined;
        current.transientHumanResume = undefined;
        current.summary = error.code;
        current.error = { code: error.code, message: error.message, retryable: false };
      } else if (error instanceof ExecutionSupersededError) {
        superseded = true;
      } else {
        current.status = "failed";
        current.phase = "fail";
        current.error = { code: "runtime_graph_failed", message: "Runtime graph execution failed", retryable: false };
      }
      if (!superseded) await saveState(current);
    }
    const current = states.get(state.runId) ?? state;
    if (!superseded) await saveState(current);
    return current;
  };

  const schedule = (state: RuntimeState, command?: Command): Promise<RuntimeState> => {
    const pending = runGraph(state, command);
    running.set(state.runId, pending);
    void pending.then((finished) => {
      if (running.get(state.runId) === pending) running.delete(state.runId);
      cleanupTerminalState(finished);
    }, () => {
      if (running.get(state.runId) === pending) running.delete(state.runId);
    });
    return pending;
  };

  function cleanupTerminalState(state: RuntimeState): void {
    if (!terminalStatuses.has(state.status) || running.has(state.runId)) return;
    states.delete(state.runId);
    budgets.delete(state.runId);
    resumeInFlight.delete(state.runId);
    dependencies.cancellationManager.forget(state.runId);
  }

  return {
    async start(state) {
      const existing = running.get(state.runId);
      if (existing !== undefined) return existing;
      dependencies.cancellationManager.register(state.runId, state.executionEpoch);
      return schedule(state);
    },
    async resume(runId, input) {
      let pending: Promise<RuntimeState> | undefined;
      await runExclusive(runId, async () => {
        const state = states.get(runId);
        if (state === undefined) throw new Error("agent_run_not_found");
        if (resumeInFlight.has(runId)) throw new Error("agent_resume_in_progress");
        if (state.status !== "interrupted" || state.pendingInterrupt === undefined) {
          throw new Error("agent_resume_not_pending");
        }
        if (state.pendingInterrupt.interruptId !== input.interruptId) throw new Error("agent_resume_interrupt_mismatch");
        const parsed = RuntimeHumanResumeSchema.parse(input);
        const resumeRef = `resume:${idFactory()}`;
        resumeValues.set(resumeRef, parsed);
        resumeInFlight.add(runId);
        try {
          dependencies.cancellationManager.renew(runId, state.executionEpoch + 1);
          pending = schedule(state, new Command({ resume: resumeRef }) as never);
          void pending.then(
            () => resumeValues.delete(resumeRef),
            () => resumeValues.delete(resumeRef)
          ).finally(() => resumeInFlight.delete(runId));
        } catch (error) {
          resumeInFlight.delete(runId);
          resumeValues.delete(resumeRef);
          throw error;
        }
      });
      if (pending === undefined) throw new Error("agent_resume_not_scheduled");
      return pending;
    },
    async cancel(runId) {
      return runExclusive(runId, async () => {
        const state = states.get(runId);
        if (state === undefined) throw new Error("agent_run_not_found");
        if (terminalStatuses.has(state.status)) return state;
        dependencies.cancellationManager.cancel(runId);
        state.status = "cancelled";
        state.phase = "cancelled";
        state.pendingInterrupt = undefined;
        state.transientHumanResume = undefined;
        state.summary = "运行已取消";
        const active = running.get(runId);
        if (active !== undefined) {
          // The AbortSignal is the cancellation handshake. Do not wait for an
          // executor that may be blocked in an external SDK; it will observe
          // the signal and reconcile the same terminal state when it returns.
          void active.catch(() => undefined);
        }
        await saveState(state);
        cleanupTerminalState(state);
        return states.get(runId) ?? state;
      });
    },
    state(runId) {
      return states.get(runId);
    },
    adopt(state) {
      states.set(state.runId, state);
      ensureBudget(state);
    }
  };

  async function runNode(
    graphState: RuntimeGraphState,
    node: string,
    callback: (state: RuntimeState) => Promise<RuntimeGraphStateUpdate>
  ): Promise<RuntimeGraphStateUpdate> {
    const state = states.get(graphState.runId);
    if (state === undefined) throw new Error("agent_run_not_found");
    updateElapsed(state);
    ensureBudget(state).assertWithin();
    state.phase = node === "human_gate" ? "human_gate" : state.phase;
    const update = await callback(state);
    states.set(state.runId, state);
    await saveState(state);
    return update;
  }

  function persist(state: RuntimeState): RuntimeGraphStateUpdate {
    state.updatedAt = now();
    state.stateHash = stateHash(state);
    return toRuntimeGraphState(state) as unknown as RuntimeGraphStateUpdate;
  }

  function consumeStep(state: RuntimeState): void {
    const budget = ensureBudget(state);
    budget.consume("steps");
    state.budget = budget.snapshot();
  }

  function consumeRetry(state: RuntimeState): void {
    const budget = ensureBudget(state);
    budget.consume("retries");
    state.budget = budget.snapshot();
  }

  function savePlan(state: RuntimeState): void {
    if (state.plan === undefined) return;
    state.planRef = dependencies.artifactStore.savePlan(state.plan);
  }

  function updateElapsed(state: RuntimeState): void {
    const elapsed = Math.max(0, Date.parse(now()) - Date.parse(state.createdAt));
    const budget = ensureBudget(state);
    budget.updateElapsed(elapsed);
    state.budget = budget.snapshot();
  }

  function ensureBudget(state: RuntimeState): BudgetManager {
    const existing = budgets.get(state.runId);
    if (existing !== undefined) return existing;
    const created = createBudgetManager(state.budgetLimits, state.budget);
    budgets.set(state.runId, created);
    return created;
  }

  function assertActive(state: RuntimeState): void {
    dependencies.cancellationManager.assertActive(state.runId);
  }

  function operationContext(state: RuntimeState): RuntimeOperationContext {
    return {
      signal: dependencies.cancellationManager.signal(state.runId),
      executionEpoch: state.executionEpoch
    };
  }

  function assertActiveEpoch(state: RuntimeState, executionEpoch: number): void {
    dependencies.cancellationManager.assertActive(state.runId);
    if (dependencies.cancellationManager.currentEpoch(state.runId) !== executionEpoch) {
      throw new ExecutionSupersededError();
    }
  }

  async function runExclusive<T>(runId: string, callback: () => Promise<T>): Promise<T> {
    const previous = locks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    locks.set(runId, current);
    try {
      // A predecessor must never be able to poison the queue. The lock
      // promises are normally resolved by `release`, but swallowing a
      // rejected predecessor keeps this invariant true if a future caller
      // supplies a custom queue implementation.
      await previous.catch(() => undefined);
      return await callback();
    } finally {
      release();
      if (locks.get(runId) === current) locks.delete(runId);
    }
  }

  async function persistCheckpoint(state: RuntimeState): Promise<void> {
    await dependencies.checkpointStore.save(toCheckpoint(state));
  }

  function toCheckpoint(state: RuntimeState) {
    return {
      version: CHECKPOINT_VERSION,
      runId: state.runId,
      ...(state.intent?.intentId === undefined ? {} : { intentId: state.intent.intentId }),
      ...(state.plan?.planId === undefined ? {} : { planId: state.plan.planId }),
      ...(state.plan?.revision === undefined ? {} : { planRevision: state.plan.revision }),
      executionEpoch: state.executionEpoch,
      phase: state.phase,
      status: state.status,
      ...(state.currentStepId === undefined ? {} : { currentStepId: state.currentStepId }),
      ...(state.intentRef === undefined ? {} : { intentRef: state.intentRef }),
      ...(state.planRef === undefined ? {} : { planRef: state.planRef }),
      memoryRefs: state.memoryRefs,
      evidenceRefs: state.evidenceRefs,
      ...(state.pendingInterrupt === undefined ? {} : { pendingInterrupt: state.pendingInterrupt }),
      budget: state.budget,
      budgetLimits: state.budgetLimits,
      completedActionIds: state.completedActionIds,
      stateHash: state.stateHash,
      // `createdAt` identifies the run, not this checkpoint revision. Keeping
      // it stable preserves wall-time budgets after a process restart.
      createdAt: state.createdAt
    };
  }
}

export function createDefaultRuntimePlanner(options: {
  idFactory?: () => string;
  now?: () => string;
} = {}): RuntimePlanner {
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  return {
    create(intent) {
      const subGoals = intent.subGoals.length > 0 ? intent.subGoals : [fallbackSubGoal(intent)];
      const steps: PlanStep[] = [];
      let previous: string | undefined;
      for (const subGoal of subGoals) {
        if (subGoal === "request_human_approval") continue;
        const id = `${subGoal}-${steps.length + 1}`;
        const risk = subGoal === "submit_application" ? "irreversible" : subGoal === "fill_application" ? "high" : "low";
        const step = PlanStepSchema.parse({
          id,
          objective: subGoal,
          owner: ownerForSubGoal(subGoal),
          status: "pending",
          dependsOn: previous === undefined ? [] : [previous],
          inputRefs: [intent.intentId],
          outputRefs: [`output:${id}`],
          attempt: 0,
          maxAttempts: 2,
          acceptanceCriteria: [`${subGoal} completed`],
          risk
        });
        steps.push(step);
        previous = id;
      }
      if (intent.riskProfile.requiresHumanApproval && !steps.some((step) => step.risk === "irreversible")) {
        const id = "final-submit";
        steps.push(PlanStepSchema.parse({
          id,
          objective: "final_submit",
          owner: "application",
          status: "pending",
          dependsOn: previous === undefined ? [] : [previous],
          inputRefs: [intent.intentId],
          outputRefs: [],
          attempt: 0,
          maxAttempts: 1,
          acceptanceCriteria: ["human approval is current"],
          risk: "irreversible"
        }));
      }
      const approvalPoints = steps.filter((step) => step.risk === "irreversible").map((step) => ({
        id: `approval:${step.id}`,
        kind: "final_submit" as const,
        stepId: step.id,
        required: true
      }));
      return PlanStateSchema.parse({
        planId: `plan:${idFactory()}`,
        intentId: intent.intentId,
        revision: 1,
        steps,
        assumptions: [],
        approvalPoints,
        estimatedCost: { steps: steps.length, toolCalls: steps.length, tokens: 0, durationMs: steps.length * 1_000 },
        createdAt: now(),
        updatedAt: now()
      });
    }
  };
}

function createDefaultSupervisor(options: { idFactory: () => string; now: () => string }): RuntimeSupervisor {
  return {
    decide({ state, readyStep }) {
      if (readyStep === undefined) return { type: "finish", outcome: "completed", summary: "没有待执行步骤" };
      if (readyStep.risk === "irreversible") {
        const interruptValue: RuntimeHumanInterrupt = {
          interruptId: `interrupt:${options.idFactory()}`,
          reason: "final_submit",
          summary: "最终提交前需要人工确认",
          evidenceRefs: state.evidenceRefs.map((ref) => ref.id),
          proposedAction: {
            stepId: readyStep.id,
            kind: "final_submit",
            planRevision: state.plan?.revision ?? 0,
            executionEpoch: state.executionEpoch
          },
          expiresAt: new Date(Date.parse(options.now()) + 15 * 60 * 1_000).toISOString()
        };
        return { type: "ask_human", interrupt: interruptValue };
      }
      return {
        type: "dispatch_agent",
        agent: `${readyStep.owner}_agent`,
        input: { stepId: readyStep.id },
        reason: `execute ${readyStep.objective}`
      };
    }
  };
}

function approvedDispatchDecision(step: PlanStep): Extract<SupervisorDecision, { type: "dispatch_agent" }> {
  return {
    type: "dispatch_agent",
    agent: `${step.owner}_agent`,
    input: { stepId: step.id },
    reason: "human approval granted"
  };
}

function routeStart(state: RuntimeGraphState): "intent" | "plan" | "dispatch" | "wait" | "inspect" | "human_gate" | typeof END {
  if (state.status === "completed" || state.status === "blocked" || state.status === "failed" || state.status === "cancelled" || state.status === "expired") return END;
  switch (state.phase) {
    case "intent": return "intent";
    case "plan": return "plan";
    case "dispatch": return "dispatch";
    case "wait": return "wait";
    case "inspect": return "inspect";
    case "human_gate": return "human_gate";
    default: return END;
  }
}

function routeAfterIntent(state: RuntimeGraphState): "plan" | "human_gate" | typeof END {
  if (state.status === "interrupted") return "human_gate";
  if (state.status !== "running") return END;
  return "plan";
}

function routeAfterPlan(state: RuntimeGraphState): "dispatch" | typeof END {
  return state.status === "running" ? "dispatch" : END;
}

function routeAfterDispatch(state: RuntimeGraphState): "wait" | "inspect" | "human_gate" | typeof END {
  if (state.status === "interrupted") return "human_gate";
  if (state.status !== "running") return END;
  return state.phase === "wait" ? "wait" : "inspect";
}

function routeAfterInspect(state: RuntimeGraphState): "dispatch" | "human_gate" | typeof END {
  if (state.status === "interrupted") return "human_gate";
  if (state.status !== "running") return END;
  return "dispatch";
}

function routeAfterHumanGate(state: RuntimeGraphState): "plan" | "wait" | "inspect" | "human_gate" | typeof END {
  if (state.status === "interrupted") return "human_gate";
  if (state.status !== "running") return END;
  if (state.phase === "plan") return "plan";
  if (state.phase === "wait") return "wait";
  return "inspect";
}

function nextStep(plan: PlanState): PlanStep | undefined {
  return plan.steps.find((step) => step.status === "pending" && step.dependsOn.every((dependency) =>
    plan.steps.some((candidate) => candidate.id === dependency && candidate.status === "completed")
  ));
}

function markStepRunning(plan: PlanState, id: string): void {
  const step = plan.steps.find((candidate) => candidate.id === id);
  if (step !== undefined) step.status = "running";
}

function markStepPending(plan: PlanState, id: string): void {
  const step = plan.steps.find((candidate) => candidate.id === id);
  if (step !== undefined) {
    step.status = "pending";
    step.attempt += 1;
  }
}

function markStepCompleted(plan: PlanState, id: string): void {
  const step = plan.steps.find((candidate) => candidate.id === id);
  if (step !== undefined) {
    step.status = "completed";
    step.attempt = Math.max(1, step.attempt);
  }
}

function markStepBlocked(plan: PlanState, id: string): void {
  const step = plan.steps.find((candidate) => candidate.id === id);
  if (step !== undefined) step.status = "blocked";
}

function hasRequiredApprovalPoint(plan: PlanState): boolean {
  const requiredStepIds = new Set(plan.approvalPoints.filter((point) => point.required).map((point) => point.stepId));
  const irreversibleSteps = plan.steps.filter((step) => step.risk === "irreversible");
  const finalSubmitStepIds = new Set(plan.approvalPoints
    .filter((point) => point.required && point.kind === "final_submit")
    .map((point) => point.stepId));
  return irreversibleSteps.length > 0
    && irreversibleSteps.every((step) => requiredStepIds.has(step.id) && finalSubmitStepIds.has(step.id));
}

function hasIrreversibleStep(plan: PlanState): boolean {
  return plan.steps.some((step) => step.risk === "irreversible");
}

function validatePlan(plan: PlanState): string | undefined {
  if (plan.steps.length === 0) return "runtime_plan_empty";
  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    if (stepIds.has(step.id) || step.status !== "pending" || step.attempt !== 0) {
      return "runtime_plan_step_invalid";
    }
    stepIds.add(step.id);
  }
  for (const step of plan.steps) {
    if (step.dependsOn.some((dependency) => dependency === step.id || !stepIds.has(dependency))) {
      return "runtime_plan_dependency_invalid";
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (visiting.has(stepId)) return false;
    if (visited.has(stepId)) return true;
    visiting.add(stepId);
    const step = plan.steps.find((candidate) => candidate.id === stepId);
    if (step === undefined || !step.dependsOn.every(visit)) return false;
    visiting.delete(stepId);
    visited.add(stepId);
    return true;
  };
  if (!plan.steps.every((step) => visit(step.id))) return "runtime_plan_dependency_invalid";
  if (plan.approvalPoints.some((point) => !stepIds.has(point.stepId))) return "runtime_plan_approval_invalid";
  return undefined;
}

function approvalBindingMatches(
  interruptValue: RuntimeHumanInterrupt,
  state: RuntimeState,
  step: PlanStep
): boolean {
  if (interruptValue.reason !== "final_submit") return false;
  const proposedAction = interruptValue.proposedAction;
  if (typeof proposedAction !== "object" || proposedAction === null || Array.isArray(proposedAction)) return false;
  const record = proposedAction as Record<string, unknown>;
  return record.stepId === step.id
    && record.kind === "final_submit"
    && record.planRevision === state.plan?.revision
    && record.executionEpoch === state.executionEpoch;
}

function clarificationRelatedFields(interruptValue: RuntimeHumanInterrupt): string[] {
  const proposedAction = interruptValue.proposedAction;
  if (typeof proposedAction !== "object" || proposedAction === null || Array.isArray(proposedAction)) {
    throw new Error("runtime_clarification_binding_invalid");
  }
  const fields = (proposedAction as Record<string, unknown>).relatedFields;
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > 32
    || fields.some((field) => typeof field !== "string" || field.length === 0 || field.length > 128)) {
    throw new Error("runtime_clarification_binding_invalid");
  }
  return [...new Set(fields)];
}

function fail(state: RuntimeState, code: string, node: string, retryable = false): RuntimeGraphStateUpdate {
  state.status = "failed";
  state.phase = "fail";
  state.pendingInterrupt = undefined;
  state.error = { code, message: code, retryable };
  state.summary = code;
  return toRuntimeGraphState(state) as unknown as RuntimeGraphStateUpdate;
}

function appendRefs(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

function appendEvidenceRefs(left: EvidenceRef[], right: EvidenceRef[]): EvidenceRef[] {
  const byId = new Map(left.map((ref) => [ref.id, ref]));
  for (const ref of right) byId.set(ref.id, ref);
  return [...byId.values()];
}

function clarificationInterrupt(
  intent: CanonicalIntent,
  question: ClarificationRequest,
  now: () => string,
  idFactory: () => string
): RuntimeHumanInterrupt {
  return {
    interruptId: `clarification:${question.questionId}:${idFactory()}`,
    reason: "ambiguous_fact",
    summary: question.question,
    evidenceRefs: intent.evidenceRefs.map((ref) => ref.id),
    proposedAction: {
      questionId: question.questionId,
      relatedFields: question.relatedFields,
      ...(question.options === undefined ? {} : { options: question.options })
    } as JsonValue,
    expiresAt: new Date(Date.parse(now()) + 15 * 60 * 1_000).toISOString()
  };
}

function isExpired(expiresAt: string, now: string): boolean {
  return Date.parse(expiresAt) <= Date.parse(now);
}

interface DeadlineSignal {
  signal: AbortSignal;
  expired(): boolean;
  dispose(): void;
}

function createDeadlineSignal(base: AbortSignal, timeoutMs: number): DeadlineSignal {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort("budget_duration_exceeded");
  }, timeoutMs);
  const onAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(base.reason);
  };
  if (base.aborted) onAbort();
  else base.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    expired: () => expired,
    dispose() {
      clearTimeout(timer);
      base.removeEventListener("abort", onAbort);
    }
  };
}

async function runWithDeadline<T>(
  state: RuntimeState,
  context: RuntimeOperationContext,
  operation: (context: RuntimeOperationContext) => Promise<T> | T
): Promise<T> {
  const remainingDuration = state.budgetLimits.maxDurationMs - state.budget.elapsedMs;
  if (remainingDuration <= 0) {
    throw new BudgetExceededError("duration", state.budget.elapsedMs, state.budgetLimits.maxDurationMs);
  }
  const deadline = createDeadlineSignal(context.signal, remainingDuration);
  try {
    const result = await operation({ ...context, signal: deadline.signal });
    if (deadline.expired()) {
      throw new BudgetExceededError("duration", state.budgetLimits.maxDurationMs + 1, state.budgetLimits.maxDurationMs);
    }
    return result;
  } catch (error) {
    if (deadline.expired()) {
      throw new BudgetExceededError("duration", state.budgetLimits.maxDurationMs + 1, state.budgetLimits.maxDurationMs);
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}

function sanitizeInterrupt(value: RuntimeHumanInterrupt): RuntimeHumanInterrupt {
  const interruptValue = RuntimeHumanInterruptSchema.parse(value);
  const encoded = JSON.stringify(interruptValue);
  if (encoded.length > 32_000) throw new Error("runtime_interrupt_too_large");
  scanInterruptPayload(interruptValue.proposedAction);
  return interruptValue;
}

function scanInterruptPayload(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    value.forEach(scanInterruptPayload);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:cookie|password|passwd|token|secret|authorization|credential|prompt|playwright|page[_-]?handle|full[_-]?dom|html|binary)/iu.test(key)) {
      throw new Error("runtime_interrupt_sensitive_field");
    }
    scanInterruptPayload(nested);
  }
}

function ownerForSubGoal(subGoal: string): "resume" | "job_matching" | "application" | "review" {
  if (subGoal.includes("resume")) return "resume";
  if (subGoal.includes("job")) return "job_matching";
  if (subGoal.includes("application") || subGoal.includes("submit") || subGoal.includes("fill")) return "application";
  return "review";
}

function fallbackSubGoal(intent: CanonicalIntent): "analyze_resume" | "analyze_job" | "review_result" {
  if (intent.primaryGoal === "analyze_resume") return "analyze_resume";
  if (intent.primaryGoal === "analyze_job") return "analyze_job";
  return "review_result";
}

function toCheckpointResult(state: RuntimeState): AgentRunResult {
  return AgentRunResultSchema.parse({
    runId: state.runId,
    status: state.status,
    ...(state.intent?.intentId === undefined ? {} : { intentId: state.intent.intentId }),
    ...(state.plan?.planId === undefined ? {} : { planId: state.plan.planId }),
    ...(state.plan?.revision === undefined ? {} : { planRevision: state.plan.revision }),
    ...(state.pendingInterrupt === undefined ? {} : { pendingInterrupt: state.pendingInterrupt }),
    ...(state.summary === undefined ? {} : { summary: state.summary }),
    ...(state.evidenceRefs.length === 0 ? {} : { evidenceRefs: state.evidenceRefs }),
    ...(state.error === undefined ? {} : { error: state.error })
  });
}

export { toCheckpointResult };
