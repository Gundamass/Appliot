import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentRunInputSchema,
  AgentRunResultSchema,
  BudgetLimitsSchema,
  RuntimeCheckpointSchema,
  RuntimeHumanResumeSchema,
  RuntimeSnapshotSchema,
  type AgentRunInput,
  type AgentRunResult,
  type BudgetLimits,
  type BudgetState,
  type RuntimeHumanResume,
  type RuntimeSnapshot
} from "@resume/contracts";
import type { IntentResolver } from "../intent/intent-resolver.js";
import type { IntentContext } from "../intent/intent-context.js";
import type { SqliteDatabase } from "../../db/client.js";
import {
  createDefaultRuntimePlanner,
  createExecutionLoop,
  toCheckpointResult,
  type ExecutionLoop,
  type RuntimeExecutor,
  type RuntimePlanner,
  type RuntimeSupervisor
} from "./execution-loop.js";
import { createCancellationManager, type CancellationManager } from "./cancellation-manager.js";
import { createRuntimeCheckpointStore, type RuntimeCheckpointStore } from "./checkpoint-store.js";
import {
  createInMemoryArtifactStore,
  createSqliteRuntimeArtifactStore,
  createInitialRuntimeState,
  RuntimeStateSchema,
  stateHash,
  type RuntimeArtifactStore,
  type RuntimeState
} from "./runtime-state.js";
import { DEFAULT_BUDGET_LIMITS } from "./budget-manager.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { CallerAttestationToken } from "../policy/caller-attestation.js";

export interface AgentRuntime {
  start(input: AgentRunInput | z.input<typeof AgentRunInputSchema>): Promise<AgentRunResult>;
  resume(runId: string, input: RuntimeHumanResume): Promise<AgentRunResult>;
  recover(runId: string): Promise<AgentRunResult>;
  cancel(runId: string): Promise<AgentRunResult>;
  inspect(runId: string): Promise<RuntimeSnapshot>;
}

export interface AgentRuntimeDependencies {
  intentResolver: IntentResolver;
  planner?: RuntimePlanner;
  executor?: RuntimeExecutor;
  supervisor?: RuntimeSupervisor;
  database?: SqliteDatabase;
  checkpointStore?: RuntimeCheckpointStore;
  artifactStore?: RuntimeArtifactStore;
  cancellationManager?: CancellationManager;
  /** Issued by the trusted composition root; never accepted from AgentRunInput. */
  callerAttestation?: CallerAttestationToken;
  langGraphCheckpointer?: BaseCheckpointSaver;
  budgetLimits?: Partial<BudgetLimits>;
  idFactory?: () => string;
  now?: () => string;
  intentContext?: (input: AgentRunInput) => IntentContext;
}

export function createAgentRuntime(dependencies: AgentRuntimeDependencies): AgentRuntime {
  const idFactory = dependencies.idFactory ?? randomUUID;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const checkpointStore = dependencies.checkpointStore ?? createRuntimeCheckpointStore(dependencies.database);
  const artifactStore = dependencies.artifactStore ?? (dependencies.database === undefined
    ? createInMemoryArtifactStore()
    : createSqliteRuntimeArtifactStore(dependencies.database));
  const cancellationManager = dependencies.cancellationManager ?? createCancellationManager();
  const defaultLimits = BudgetLimitsSchema.parse({ ...DEFAULT_BUDGET_LIMITS, ...dependencies.budgetLimits });
  const loop: ExecutionLoop = createExecutionLoop({
    intentResolver: dependencies.intentResolver,
    planner: dependencies.planner ?? createDefaultRuntimePlanner({ idFactory, now }),
    executor: dependencies.executor ?? { execute: async () => ({ status: "completed" as const }) },
    ...(dependencies.supervisor === undefined ? {} : { supervisor: dependencies.supervisor }),
    checkpointStore,
    artifactStore,
    cancellationManager,
    ...(dependencies.callerAttestation === undefined
      ? {}
      : { callerAttestation: dependencies.callerAttestation }),
    ...(dependencies.langGraphCheckpointer === undefined ? {} : { langGraphCheckpointer: dependencies.langGraphCheckpointer }),
    idFactory,
    now,
    ...(dependencies.intentContext === undefined ? {} : { intentContext: dependencies.intentContext })
  });

  const restore = async (runId: string): Promise<RuntimeState> => {
    const existing = loop.state(runId);
    if (existing !== undefined) return existing;
    const checkpoint = await checkpointStore.latest(runId);
    if (checkpoint === undefined) throw new Error("agent_run_not_found");
    const intent = checkpoint.intentRef === undefined ? undefined : artifactStore.getIntent(checkpoint.intentRef);
    const plan = checkpoint.planRef === undefined ? undefined : artifactStore.getPlan(checkpoint.planRef);
    if (checkpoint.intentRef !== undefined && intent === undefined) throw new Error("agent_intent_artifact_missing");
    if (checkpoint.planRef !== undefined && plan === undefined) throw new Error("agent_plan_artifact_missing");
    const budgetLimits = checkpoint.budgetLimits ?? defaultLimits;
    const inFlightStep = checkpoint.status === "running"
      ? plan?.steps.find((step) => step.status === "running")
      : undefined;
    const exceededBudgetMetric = budgetExceededMetric(checkpoint.budget, budgetLimits);
    const inferredPhase = checkpoint.status === "interrupted"
      ? "human_gate"
      : checkpoint.status === "completed"
        ? "complete"
        : checkpoint.status === "blocked"
          ? "blocked"
          : checkpoint.status === "cancelled"
            ? "cancelled"
            : checkpoint.planRef === undefined
              ? "plan"
              : "dispatch";
    const candidateState = RuntimeStateSchema.parse({
      runId: checkpoint.runId,
      requestedBy: "restored",
      status: checkpoint.status,
      phase: checkpoint.phase ?? inferredPhase,
      executionEpoch: checkpoint.executionEpoch,
      ...(checkpoint.intentRef === undefined ? {} : { intentRef: checkpoint.intentRef, intent }),
      ...(checkpoint.planRef === undefined ? {} : { planRef: checkpoint.planRef, plan }),
      ...(checkpoint.currentStepId === undefined ? {} : { currentStepId: checkpoint.currentStepId }),
      ...(checkpoint.pendingInterrupt === undefined ? {} : { pendingInterrupt: checkpoint.pendingInterrupt }),
      budget: checkpoint.budget,
      budgetLimits,
      memoryRefs: checkpoint.memoryRefs,
      evidenceRefs: checkpoint.evidenceRefs,
      completedActionIds: checkpoint.completedActionIds,
      stateHash: checkpoint.stateHash,
      createdAt: checkpoint.createdAt,
      updatedAt: checkpoint.createdAt
    });
    const integrityInvalid = checkpoint.phase !== undefined && stateHash(candidateState) !== checkpoint.stateHash;
    const restoredStatus = !integrityInvalid && inFlightStep === undefined && exceededBudgetMetric === undefined
      ? checkpoint.status
      : "blocked";
    const phase = integrityInvalid ? "blocked" : checkpoint.phase ?? inferredPhase;
    const state = RuntimeStateSchema.parse({
      runId: checkpoint.runId,
      requestedBy: "restored",
      status: restoredStatus,
      phase,
      executionEpoch: checkpoint.executionEpoch,
      ...(checkpoint.intentRef === undefined ? {} : { intentRef: checkpoint.intentRef, intent }),
      ...(checkpoint.planRef === undefined ? {} : { planRef: checkpoint.planRef, plan }),
      ...(checkpoint.currentStepId === undefined ? {} : { currentStepId: checkpoint.currentStepId }),
      ...(checkpoint.pendingInterrupt === undefined ? {} : { pendingInterrupt: checkpoint.pendingInterrupt }),
      budget: checkpoint.budget,
      budgetLimits,
      memoryRefs: checkpoint.memoryRefs,
      evidenceRefs: checkpoint.evidenceRefs,
      completedActionIds: checkpoint.completedActionIds,
      stateHash: checkpoint.stateHash,
      createdAt: checkpoint.createdAt,
      updatedAt: checkpoint.createdAt,
      ...(!integrityInvalid && inFlightStep === undefined && exceededBudgetMetric === undefined ? {} : {
        summary: integrityInvalid
          ? "Checkpoint 完整性校验失败"
          : inFlightStep === undefined
            ? `进程重启时预算已耗尽：${exceededBudgetMetric}`
            : "进程重启后检测到未完成的步骤，需人工核对外部动作结果",
        error: {
          code: integrityInvalid
            ? "runtime_checkpoint_integrity_invalid"
            : inFlightStep === undefined ? `budget_${exceededBudgetMetric}` : "runtime_inflight_step_uncertain",
          message: integrityInvalid
            ? "Checkpoint 完整性校验失败"
            : inFlightStep === undefined ? "进程重启时预算已耗尽" : "进程重启后步骤执行结果不确定",
          retryable: false,
          ...(integrityInvalid || inFlightStep === undefined ? {} : { stepId: inFlightStep.id })
        }
      })
    });
    if (integrityInvalid || inFlightStep !== undefined || exceededBudgetMetric !== undefined) {
      state.stateHash = stateHash(state);
      const { pendingInterrupt: _pendingInterrupt, ...checkpointWithoutInterrupt } = checkpoint;
      await checkpointStore.save({
        ...checkpointWithoutInterrupt,
        status: "blocked",
        phase: "blocked",
        ...(checkpoint.budgetLimits === undefined ? { budgetLimits } : {}),
        stateHash: state.stateHash
      });
    }
    loop.adopt(state);
    return state;
  };

  return {
    async start(input) {
      const parsed = AgentRunInputSchema.parse(input);
      const runId = idFactory();
      const limits = BudgetLimitsSchema.parse({ ...defaultLimits, ...(parsed.budget ?? {}) });
      const state = createInitialRuntimeState(runId, parsed, limits, now());
      const result = await loop.start(state);
      return toCheckpointResult(result);
    },
    async resume(runId, input) {
      const state = await restore(assertRunId(runId));
      const parsed = RuntimeHumanResumeSchema.parse(input);
      if (state.status !== "interrupted" || state.pendingInterrupt === undefined) {
        throw new Error("agent_resume_not_pending");
      }
      if (state.pendingInterrupt.interruptId !== parsed.interruptId) {
        throw new Error("agent_resume_interrupt_mismatch");
      }
      const result = await loop.resume(runId, parsed);
      return toCheckpointResult(result);
    },
    async recover(runId) {
      const state = await restore(assertRunId(runId));
      if (state.status !== "running") throw new Error("agent_run_not_recoverable");
      const result = await loop.start(state);
      return toCheckpointResult(result);
    },
    async cancel(runId) {
      const state = await restore(assertRunId(runId));
      if (["completed", "blocked", "failed", "cancelled", "expired"].includes(state.status)) {
        return toCheckpointResult(state);
      }
      const result = await loop.cancel(runId);
      return toCheckpointResult(result);
    },
    async inspect(runId) {
      const state = await restore(assertRunId(runId));
      const checkpoint = await checkpointStore.latest(state.runId);
      if (checkpoint === undefined) throw new Error("agent_checkpoint_missing");
      return RuntimeSnapshotSchema.parse({
        runId: state.runId,
        status: checkpoint.status,
        checkpoint: RuntimeCheckpointSchema.parse(checkpoint),
        updatedAt: checkpoint.createdAt
      });
    }
  };
}

function assertRunId(runId: string): string {
  if (typeof runId !== "string" || runId.length === 0) throw new Error("agent_run_id_required");
  return runId;
}

function budgetExceededMetric(budget: BudgetState, limits: BudgetLimits): string | undefined {
  const checks: Array<[string, number, number]> = [
    ["steps_exceeded", budget.steps, limits.maxSteps],
    ["tool_calls_exceeded", budget.toolCalls, limits.maxToolCalls],
    ["retries_exceeded", budget.retries, limits.maxRetries],
    ["replans_exceeded", budget.replans, limits.maxReplans],
    ["tokens_exceeded", budget.tokens, limits.maxTokens],
    ["duration_exceeded", budget.elapsedMs, limits.maxDurationMs]
  ];
  return checks.find(([, current, limit]) => current > limit)?.[0];
}
