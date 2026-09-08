import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type { CanonicalIntent, IntentResolution, PlanStep } from "@resume/contracts";
import { createAgentRuntime } from "./agent-runtime.js";
import { createRuntimeCheckpointStore } from "./checkpoint-store.js";
import { createCancellationManager } from "./cancellation-manager.js";
import { createInMemoryArtifactStore, stateHash, type RuntimeState } from "./runtime-state.js";
import type { RuntimeExecutorInput } from "./execution-loop.js";
import { createApprovalSystem } from "../policy/approval-gate.js";
import { createInMemoryAgentEventTraceSink } from "../events/trace-sink.js";

const intent: CanonicalIntent = {
  intentId: "intent-1",
  schemaVersion: "1.0.0",
  revision: 1,
  rawInputRef: "message-1",
  primaryGoal: "submit_application",
  subGoals: ["identify_target_job", "prepare_application", "request_human_approval", "submit_application"],
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
  successCriteria: [{ id: "approved", description: "人工确认后完成投递", required: true }],
  riskProfile: {
    level: "irreversible",
    requiresHumanApproval: true,
    reasons: ["external application action"]
  },
  confidence: 1,
  ambiguities: [],
  missingInformation: [],
  autonomyLevel: "execute_with_approval",
  evidenceRefs: [],
  createdAt: "2026-09-02T00:00:00.000Z"
};

const resolved: IntentResolution = { type: "resolved", intent };

function applicationStep(id: string, risk: PlanStep["risk"]): PlanStep {
  return {
    id,
    objective: id,
    owner: "application",
    status: "pending",
    dependsOn: [],
    inputRefs: ["intent-1"],
    outputRefs: [],
    attempt: 0,
    maxAttempts: 2,
    acceptanceCriteria: ["step complete"],
    risk
  };
}

describe("AgentRuntime", () => {
  it("saves a bounded checkpoint and resumes after an approval interruption", async () => {
    const checkpointStore = createRuntimeCheckpointStore();
    const approvals = createApprovalSystem({
      signingKey: Buffer.alloc(32, 17),
      verifyHumanPrincipal: () => ({ subject: "user-1" }),
      idFactory: () => "approval-1",
      now: () => "2026-09-02T00:00:00.000Z"
    });
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      checkpointStore,
      planner: {
        create: async () => ({
          planId: "plan-1",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("prepare", "medium"), {
            ...applicationStep("submit", "irreversible"),
            approvalBinding: {
              snapshotId: "snapshot-1",
              targetFingerprint: "target-1",
              payloadHash: "a".repeat(64)
            }
          }],
          assumptions: [],
          approvalPoints: [{ id: "approval-1", kind: "final_submit", stepId: "submit", required: true }],
          estimatedCost: { steps: 2, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      idFactory: (() => {
        let index = 0;
        return () => `id-${++index}`;
      })(),
      now: () => "2026-09-02T00:00:00.000Z",
      approvalGate: approvals.gate
    });

    const first = await runtime.start({ goal: "帮我投递这个岗位", requestedBy: "user-1" });
    expect(first.status).toBe("interrupted");

    const snapshot = await runtime.inspect(first.runId);
    expect(snapshot.checkpoint.pendingInterrupt).toBeDefined();
    expect(JSON.stringify(snapshot)).not.toContain("cookie");

    const approval = approvals.issuer.issue({
      binding: {
        runId: first.runId,
        planRevision: 1,
        executionEpoch: 0,
        snapshotId: "snapshot-1",
        targetFingerprint: "target-1",
        payloadHash: "a".repeat(64)
      },
      principal: { subject: "user-1" }
    });
    const resumed = await runtime.resume(first.runId, {
      interruptId: first.pendingInterrupt!.interruptId,
      action: "approve",
      values: { approval }
    });
    expect(resumed.status).toBe("completed");
    expect((await runtime.inspect(first.runId)).checkpoint.executionEpoch).toBe(1);
  });

  it("does not treat a bare approve as a final-submit authorization", async () => {
    let executorCalls = 0;
    const approvals = createApprovalSystem({
      signingKey: Buffer.alloc(32, 18),
      verifyHumanPrincipal: () => ({ subject: "user-1" }),
      now: () => "2026-09-02T00:00:00.000Z"
    });
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      planner: {
        create: async () => ({
          planId: "plan-bare-approve",
          intentId: "intent-1",
          revision: 1,
          steps: [{
            ...applicationStep("submit", "irreversible"),
            approvalBinding: {
              snapshotId: "snapshot-1",
              targetFingerprint: "target-1",
              payloadHash: "b".repeat(64)
            }
          }],
          assumptions: [],
          approvalPoints: [{ id: "approval-submit", kind: "final_submit", stepId: "submit", required: true }],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      executor: { execute: async () => { executorCalls += 1; return { status: "completed" as const }; } },
      approvalGate: approvals.gate,
      idFactory: () => "run-bare-approve",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const first = await runtime.start({ goal: "submit application", requestedBy: "user-1" });
    const rejected = await runtime.resume(first.runId, {
      interruptId: first.pendingInterrupt!.interruptId,
      action: "approve",
      values: {}
    });

    expect(rejected.status).toBe("failed");
    expect(rejected.error?.code).toBe("runtime_approval_required");
    expect(executorCalls).toBe(0);
  });

  it("restores a safe request context for a resumed runtime without the raw request", async () => {
    const checkpointStore = createRuntimeCheckpointStore();
    const artifactStore = createInMemoryArtifactStore();
    const approvals = createApprovalSystem({
      signingKey: Buffer.alloc(32, 19),
      verifyHumanPrincipal: () => ({ subject: "user-1" }),
      idFactory: () => "approval-restart",
      now: () => "2026-09-02T00:00:00.000Z"
    });
    const plan = {
      planId: "plan-restart-context",
      intentId: "intent-1",
      revision: 1,
      steps: [{
        ...applicationStep("submit", "irreversible"),
        approvalBinding: {
          snapshotId: "snapshot-restart",
          targetFingerprint: "target-restart",
          payloadHash: "c".repeat(64)
        }
      }],
      assumptions: [],
      approvalPoints: [{ id: "approval-submit", kind: "final_submit" as const, stepId: "submit", required: true }],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z"
    };
    const initial = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      checkpointStore,
      artifactStore,
      planner: { create: async () => plan },
      executor: { execute: async () => ({ status: "completed" as const }) },
      approvalGate: approvals.gate,
      idFactory: () => "run-restart-context",
      now: () => "2026-09-02T00:00:00.000Z"
    });
    const first = await initial.start({
      goal: "submit application without persisting this raw request",
      requestedBy: "user-1",
      contextRefs: ["context:profile-1"],
      autonomyLevel: "execute_with_approval",
      metadata: {
        applicationTaskId: "task-restart",
        applicationUrl: "https://jobs.example.test/restart",
        profileRevision: 7
      }
    });
    expect(first.status).toBe("interrupted");
    const checkpoint = await checkpointStore.latest(first.runId);
    expect(checkpoint?.requestContextRef).toMatch(/^request-context:/u);
    expect(JSON.stringify(checkpoint)).not.toContain("submit application without persisting");

    let resumedInput: RuntimeExecutorInput | undefined;
    const restarted = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      checkpointStore,
      artifactStore,
      executor: { execute: async (input) => { resumedInput = input; return { status: "completed" as const }; } },
      approvalGate: approvals.gate,
      now: () => "2026-09-02T00:00:00.000Z"
    });
    const approval = approvals.issuer.issue({
      binding: {
        runId: first.runId,
        planRevision: 1,
        executionEpoch: 0,
        snapshotId: "snapshot-restart",
        targetFingerprint: "target-restart",
        payloadHash: "c".repeat(64)
      },
      principal: { subject: "user-1" }
    });
    const resumed = await restarted.resume(first.runId, {
      interruptId: first.pendingInterrupt!.interruptId,
      action: "approve",
      values: { approval }
    });

    expect(resumed.status).toBe("completed");
    expect(resumedInput?.request).toBeUndefined();
    expect(resumedInput?.requestContext).toMatchObject({
      requestedBy: "user-1",
      contextRefs: ["context:profile-1"],
      metadata: {
        applicationTaskId: "task-restart",
        applicationUrl: "https://jobs.example.test/restart",
        profileRevision: 7
      }
    });
  });

  it("writes authoritative lifecycle events from the Runtime itself", async () => {
    const events = createInMemoryAgentEventTraceSink({ now: () => "2026-09-04T00:00:00.000Z" });
    const runtime = createAgentRuntime({
      intentResolver: {
        resolve: async (): Promise<IntentResolution> => ({
          ...resolved,
          intent: {
            ...intent,
            primaryGoal: "analyze_resume",
            subGoals: ["review_result"],
            riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
            autonomyLevel: "prepare"
          }
        })
      },
      planner: {
        create: async () => ({
          planId: "plan-authoritative-events",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("review", "low")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-04T00:00:00.000Z",
          updatedAt: "2026-09-04T00:00:00.000Z"
        })
      },
      executor: { execute: async () => ({ status: "completed" as const }) },
      eventSink: events,
      idFactory: () => "run-authoritative-events",
      now: () => "2026-09-04T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "analyze resume", requestedBy: "user-1" });
    const runtimeEvents = events.list(result.runId);

    expect(runtimeEvents.map((event) => event.type)).toEqual(expect.arrayContaining([
      "run_started",
      "intent_resolved",
      "plan_created",
      "agent_dispatched",
      "checkpoint_saved",
      "run_completed"
    ]));
    expect(runtimeEvents.every((event) => event.runId === result.runId)).toBe(true);
  });

  it("records a non-final human response in the Runtime event stream", async () => {
    const events = createInMemoryAgentEventTraceSink({ now: () => "2026-09-04T00:00:00.000Z" });
    let interrupted = false;
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => ({
        ...resolved,
        intent: {
          ...intent,
          primaryGoal: "analyze_resume",
          subGoals: ["review_result"],
          riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
          autonomyLevel: "prepare"
        }
      }) },
      planner: {
        create: async () => ({
          planId: "plan-human-response-events",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("review", "low")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-04T00:00:00.000Z",
          updatedAt: "2026-09-04T00:00:00.000Z"
        })
      },
      supervisor: {
        decide: ({ readyStep }) => {
          if (readyStep === undefined) throw new Error("test_ready_step_missing");
          return {
          type: "dispatch_agent",
          agent: "application_agent",
          input: { stepId: readyStep.id },
          reason: "test"
          };
        }
      },
      executor: {
        execute: async () => {
          if (!interrupted) {
            interrupted = true;
            return {
              status: "interrupted" as const,
              pendingInterrupt: {
                interruptId: "interrupt-human-response-events",
                reason: "high_risk_action" as const,
                summary: "Human response required",
                evidenceRefs: [],
                expiresAt: "2026-09-04T00:15:00.000Z"
              }
            };
          }
          return { status: "completed" as const };
        }
      },
      eventSink: events,
      idFactory: () => "run-human-response-events",
      now: () => "2026-09-04T00:00:00.000Z"
    });

    const first = await runtime.start({ goal: "analyze resume", requestedBy: "user-1" });
    await runtime.resume(first.runId, {
      interruptId: first.pendingInterrupt!.interruptId,
      action: "confirm",
      values: {}
    });

    const responseEvents = events.list(first.runId).filter((event) => event.type === "clarification_received");
    expect(responseEvents).toHaveLength(1);
    expect(responseEvents[0]?.actor).toBe("user");
  });

  it("cancels a running executor and prevents new work", async () => {
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { release = resolve; });
    let signal: AbortSignal | undefined;
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => ({
        ...resolved,
        intent: { ...intent, primaryGoal: "analyze_resume", subGoals: ["review_result"], riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] }, autonomyLevel: "prepare" }
      }) },
      executor: {
        execute: async ({ signal: currentSignal }) => {
          signal = currentSignal;
          await started;
          return { status: "completed" as const };
        }
      },
      checkpointStore: createRuntimeCheckpointStore(),
      idFactory: () => "run-1"
    });

    const running = runtime.start({ goal: "分析简历", requestedBy: "user-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancelled = await runtime.cancel("run-1");
    release?.();

    expect(cancelled.status).toBe("cancelled");
    expect(signal?.aborted).toBe(true);
    expect((await running).status).toBe("cancelled");
  });

  it("does not apply an intent result that returns after cancellation", async () => {
    let releaseResolver: (() => void) | undefined;
    let resolverStarted: (() => void) | undefined;
    const resolverStartedPromise = new Promise<void>((resolve) => { resolverStarted = resolve; });
    const resolverReleasePromise = new Promise<void>((resolve) => { releaseResolver = resolve; });
    let plannerCalls = 0;
    const runtime = createAgentRuntime({
      intentResolver: {
        resolve: async (): Promise<IntentResolution> => {
          resolverStarted?.();
          await resolverReleasePromise;
          return resolved;
        }
      },
      planner: {
        create: async () => {
          plannerCalls += 1;
          return {
            planId: "plan-cancel-race",
            intentId: "intent-1",
            revision: 1,
            steps: [applicationStep("prepare", "low")],
            assumptions: [],
            approvalPoints: [],
            estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
            createdAt: "2026-09-02T00:00:00.000Z",
            updatedAt: "2026-09-02T00:00:00.000Z"
          };
        }
      },
      checkpointStore: createRuntimeCheckpointStore(),
      idFactory: () => "run-cancel-race",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const running = runtime.start({ goal: "分析简历", requestedBy: "user-1" });
    await resolverStartedPromise;
    const cancelled = await runtime.cancel("run-cancel-race");
    releaseResolver?.();

    expect(cancelled.status).toBe("cancelled");
    expect((await running).status).toBe("cancelled");
    expect(plannerCalls).toBe(0);
  });

  it("resumes a clarification interrupt after a fresh runtime is created", async () => {
    const needsClarification: IntentResolution = {
      type: "needs_clarification",
        intent: {
          ...intent,
          primaryGoal: "prepare_application",
          subGoals: ["identify_target_job", "prepare_application"],
          riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
          autonomyLevel: "prepare",
        missingInformation: [{
          field: "targetJob",
          reason: "需要明确目标岗位",
          blocking: true,
          priority: 100
        }]
      },
      question: {
        questionId: "clarify-targetJob",
        question: "请选择目标岗位",
        blocking: true,
        relatedFields: ["targetJob"]
      }
    };
    const checkpointStore = createRuntimeCheckpointStore();
    const artifactStore = createInMemoryArtifactStore();
    const dependencies = {
      intentResolver: { resolve: async (): Promise<IntentResolution> => needsClarification },
      planner: {
        create: async (resolvedIntent: CanonicalIntent) => ({
          planId: "plan-clarified",
          intentId: resolvedIntent.intentId,
          revision: resolvedIntent.revision,
          steps: [applicationStep("prepare", "medium")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      checkpointStore,
      artifactStore,
      idFactory: () => "run-clarification",
      now: () => "2026-09-02T00:00:00.000Z"
    } as const;

    const first = await createAgentRuntime(dependencies).start({ goal: "帮我申请岗位", requestedBy: "user-1" });
    expect(first.status).toBe("interrupted");
    const secondRuntime = createAgentRuntime({ ...dependencies, idFactory: () => "unused" });
    const resumed = await secondRuntime.resume(first.runId, {
      interruptId: first.pendingInterrupt!.interruptId,
      action: "correct",
      values: { targetJob: "job-1" }
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.intentId).toBe(intent.intentId);
    expect((await secondRuntime.inspect(first.runId)).checkpoint.budget.replans).toBe(1);
  });

  it("fails closed when a clarification answer is not bound to the pending question", async () => {
    const needsClarification: IntentResolution = {
      type: "needs_clarification",
      intent: {
        ...intent,
        primaryGoal: "prepare_application",
        subGoals: ["identify_target_job", "prepare_application"],
        riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
        autonomyLevel: "prepare",
        missingInformation: [{
          field: "targetJob",
          reason: "target job is required",
          blocking: true,
          priority: 100
        }]
      },
      question: {
        questionId: "clarify-targetJob-sensitive",
        question: "choose target job",
        blocking: true,
        relatedFields: ["targetJob"]
      }
    };
    const checkpointStore = createRuntimeCheckpointStore();
    const artifactStore = createInMemoryArtifactStore();
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => needsClarification },
      planner: {
        create: async (resolvedIntent: CanonicalIntent) => ({
          planId: "plan-sensitive-clarification",
          intentId: resolvedIntent.intentId,
          revision: resolvedIntent.revision,
          steps: [applicationStep("prepare", "low")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      checkpointStore,
      artifactStore,
      idFactory: () => "run-sensitive-clarification",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const first = await runtime.start({ goal: "prepare application", requestedBy: "user-1" });
    const failed = await runtime.resume(first.runId, {
      interruptId: first.pendingInterrupt!.interruptId,
      action: "correct",
      values: { password: "secret" }
    });

    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("runtime_clarification_answer_invalid");
    expect(JSON.stringify(await checkpointStore.list(first.runId))).not.toContain("secret");
  });

  it("blocks an approval resume when the wall-time budget expires while waiting", async () => {
    let clock = Date.parse("2026-09-02T00:00:00.000Z");
    let executorCalls = 0;
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      planner: {
        create: async () => ({
          planId: "plan-expired-approval",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("submit", "irreversible")],
          assumptions: [],
          approvalPoints: [{ id: "approval-submit", kind: "final_submit", stepId: "submit", required: true }],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      executor: {
        execute: async () => {
          executorCalls += 1;
          return { status: "completed" as const };
        }
      },
      budgetLimits: { maxDurationMs: 1_000 },
      idFactory: () => "run-expired-approval",
      now: () => new Date(clock).toISOString()
    });

    const first = await runtime.start({ goal: "submit application", requestedBy: "user-1" });
    clock += 1_001;
    const resumed = await runtime.resume(first.runId, {
      interruptId: first.pendingInterrupt!.interruptId,
      action: "approve",
      values: { approvalId: "approval-1" }
    });

    expect(resumed.status).toBe("blocked");
    expect(resumed.error?.code).toBe("budget_duration_exceeded");
    expect(executorCalls).toBe(0);
  });

  it("releases the run lock when a queued operation rejects before scheduling", async () => {
    const needsClarification: IntentResolution = {
      type: "needs_clarification",
      intent: {
        ...intent,
        primaryGoal: "prepare_application",
        subGoals: ["identify_target_job", "prepare_application"],
        riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
        autonomyLevel: "prepare",
        missingInformation: [{ field: "targetJob", reason: "target job is required", blocking: true, priority: 100 }]
      },
      question: {
        questionId: "clarify-lock",
        question: "choose target job",
        blocking: true,
        relatedFields: ["targetJob"]
      }
    };
    const baseCancellation = createCancellationManager();
    let failFirstRenew = true;
    const cancellationManager = {
      ...baseCancellation,
      renew(runId: string, executionEpoch: number) {
        if (failFirstRenew) {
          failFirstRenew = false;
          throw new Error("renew_failed");
        }
        return baseCancellation.renew(runId, executionEpoch);
      }
    };
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => needsClarification },
      planner: {
        create: async (resolvedIntent: CanonicalIntent) => ({
          planId: "plan-lock-release",
          intentId: resolvedIntent.intentId,
          revision: resolvedIntent.revision,
          steps: [applicationStep("prepare", "low")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      cancellationManager,
      idFactory: () => "run-lock-release",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const first = await runtime.start({ goal: "prepare application", requestedBy: "user-1" });
    const answer = {
      interruptId: first.pendingInterrupt!.interruptId,
      action: "correct" as const,
      values: { targetJob: "job-1" }
    };
    await expect(runtime.resume(first.runId, answer)).rejects.toThrow("renew_failed");
    const resumed = await runtime.resume(first.runId, answer);

    expect(resumed.status).toBe("completed");
  });

  it("serializes concurrent resume calls for one interrupt", async () => {
    const needsClarification: IntentResolution = {
      type: "needs_clarification",
      intent: {
        ...intent,
        primaryGoal: "prepare_application",
        subGoals: ["prepare_application"],
        riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
        autonomyLevel: "prepare",
        missingInformation: [{ field: "targetJob", reason: "需要明确目标岗位", blocking: true, priority: 100 }]
      },
      question: {
        questionId: "clarify-concurrent-targetJob",
        question: "请选择目标岗位",
        blocking: true,
        relatedFields: ["targetJob"]
      }
    };
    const checkpointStore = createRuntimeCheckpointStore();
    const artifactStore = createInMemoryArtifactStore();
    let executorCalls = 0;
    let releaseExecutor: (() => void) | undefined;
    let executorStarted: (() => void) | undefined;
    const executorStartedPromise = new Promise<void>((resolve) => { executorStarted = resolve; });
    const executorReleasePromise = new Promise<void>((resolve) => { releaseExecutor = resolve; });
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => needsClarification },
      planner: {
        create: async (resolvedIntent: CanonicalIntent) => ({
          planId: "plan-concurrent-resume",
          intentId: resolvedIntent.intentId,
          revision: resolvedIntent.revision,
          steps: [applicationStep("prepare", "low")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      executor: {
        execute: async () => {
          executorCalls += 1;
          executorStarted?.();
          await executorReleasePromise;
          return { status: "completed" as const };
        }
      },
      checkpointStore,
      artifactStore,
      idFactory: (() => {
        let index = 0;
        return () => `concurrent-${++index}`;
      })(),
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const first = await runtime.start({ goal: "帮我申请岗位", requestedBy: "user-1" });
    const resume = {
      interruptId: first.pendingInterrupt!.interruptId,
      action: "correct" as const,
      values: { targetJob: "job-1" }
    };
    const left = runtime.resume(first.runId, resume);
    const right = runtime.resume(first.runId, resume);
    const outcomesPromise = Promise.allSettled([left, right]);
    await executorStartedPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executorCalls).toBe(1);
    releaseExecutor?.();

    const outcomes = await outcomesPromise;
    expect(executorCalls).toBe(1);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });

  it("serializes cancellation with a concurrent resume and never completes after cancellation", async () => {
    let executorCalls = 0;
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      planner: {
        create: async () => ({
          planId: "plan-cancel-resume-race",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("submit", "irreversible")],
          assumptions: [],
          approvalPoints: [{ id: "approval-submit", kind: "final_submit", stepId: "submit", required: true }],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      executor: {
        execute: async () => {
          executorCalls += 1;
          return { status: "completed" as const };
        }
      },
      idFactory: (() => {
        let index = 0;
        return () => `cancel-resume-${++index}`;
      })(),
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const first = await runtime.start({ goal: "直接提交", requestedBy: "user-1" });
    const resumePromise = runtime.resume(first.runId, {
      interruptId: first.pendingInterrupt!.interruptId,
      action: "approve",
      values: { approvalId: "human-approval" }
    });
    await Promise.resolve();
    const cancelResult = await runtime.cancel(first.runId);
    const resumeResult = await resumePromise;

    expect(cancelResult.status).toBe("cancelled");
    expect(resumeResult.status).toBe("cancelled");
    expect((await runtime.inspect(first.runId)).status).toBe("cancelled");
    expect(executorCalls).toBe(0);
  });

  it("blocks when the step budget is exhausted before dispatching another step", async () => {
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => ({
        ...resolved,
        intent: {
          ...intent,
          primaryGoal: "analyze_resume",
          subGoals: ["review_result", "track_application"],
          riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
          autonomyLevel: "prepare"
        }
      }) },
      planner: {
        create: async () => ({
          planId: "plan-budget",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("one", "low"), applicationStep("two", "low")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 2, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      budgetLimits: { maxSteps: 1 },
      idFactory: () => "run-budget",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "分析简历", requestedBy: "user-1" });
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("budget_steps_exceeded");
  });

  it("enforces maxAttemptsPerStep independently for each step", async () => {
    let executorCalls = 0;
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => ({
        ...resolved,
        intent: {
          ...intent,
          primaryGoal: "analyze_resume",
          subGoals: ["review_result"],
          riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
          autonomyLevel: "prepare"
        }
      }) },
      planner: {
        create: async () => ({
          planId: "plan-attempt-limit",
          intentId: "intent-1",
          revision: 1,
          steps: [{ ...applicationStep("retryable", "low"), maxAttempts: 4 }],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      executor: {
        execute: async () => {
          executorCalls += 1;
          return { status: "failed" as const, errorCode: "temporary", retryable: true };
        }
      },
      budgetLimits: { maxAttemptsPerStep: 1 },
      idFactory: () => "run-attempt-limit",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "分析简历", requestedBy: "user-1" });
    expect(result.status).toBe("failed");
    expect(executorCalls).toBe(1);
  });

  it("counts tool calls reported by an executor", async () => {
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => ({
        ...resolved,
        intent: {
          ...intent,
          primaryGoal: "analyze_resume",
          subGoals: ["review_result"],
          riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
          autonomyLevel: "prepare"
        }
      }) },
      planner: {
        create: async () => ({
          planId: "plan-tool-count",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("tool-step", "low")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 3, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      supervisor: {
        decide: () => ({
          type: "invoke_tool" as const,
          capability: "profile.lookup",
          input: {},
          reason: "load profile evidence"
        })
      },
      executor: { execute: async () => ({ status: "completed" as const, toolCallsUsed: 3 }) },
      budgetLimits: { maxToolCalls: 3 },
      idFactory: () => "run-tool-count",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "分析简历", requestedBy: "user-1" });
    expect(result.status).toBe("completed");
    expect((await runtime.inspect(result.runId)).checkpoint.budget.toolCalls).toBe(3);
  });

  it("aborts a long-running executor when the duration budget expires", async () => {
    let aborted = false;
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => ({
        ...resolved,
        intent: {
          ...intent,
          primaryGoal: "analyze_resume",
          subGoals: ["review_result"],
          riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
          autonomyLevel: "prepare"
        }
      }) },
      planner: {
        create: async () => ({
          planId: "plan-duration",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("slow", "low")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      executor: {
        execute: async ({ signal }) => await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ status: "completed" as const }), 60);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted = true;
            resolve({ status: "failed" as const, errorCode: "aborted", retryable: false });
          }, { once: true });
        })
      },
      budgetLimits: { maxDurationMs: 15 },
      idFactory: () => "run-duration",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "分析简历", requestedBy: "user-1" });
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("budget_duration_exceeded");
    expect(aborted).toBe(true);
  });

  it("fails closed when a supervisor tries to dispatch an irreversible step", async () => {
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      planner: {
        create: async () => ({
          planId: "plan-bypass",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("submit", "irreversible")],
          assumptions: [],
          approvalPoints: [{ id: "approval-submit", kind: "final_submit", stepId: "submit", required: true }],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      supervisor: {
        decide: () => ({
          type: "dispatch_agent" as const,
          agent: "application_agent",
          input: { stepId: "submit" },
          reason: "try to bypass approval"
        })
      },
      idFactory: () => "run-bypass",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "直接提交", requestedBy: "user-1" });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("runtime_approval_required");
  });

  it("does not allow a supervisor to finish while a step is still pending", async () => {
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => ({
        ...resolved,
        intent: {
          ...intent,
          primaryGoal: "analyze_resume",
          subGoals: ["review_result"],
          riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
          autonomyLevel: "prepare"
        }
      }) },
      planner: {
        create: async () => ({
          planId: "plan-finish-bypass",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("pending", "low")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      supervisor: {
        decide: () => ({ type: "finish" as const, outcome: "completed" as const, summary: "伪造完成" })
      },
      idFactory: () => "run-finish-bypass",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "分析简历", requestedBy: "user-1" });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("runtime_supervisor_finish_not_allowed");
  });

  it("requires an irreversible approval interrupt to bind the active step and plan revision", async () => {
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      planner: {
        create: async () => ({
          planId: "plan-unbound-approval",
          intentId: "intent-1",
          revision: 3,
          steps: [applicationStep("submit", "irreversible")],
          assumptions: [],
          approvalPoints: [{ id: "approval-submit", kind: "final_submit", stepId: "submit", required: true }],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      supervisor: {
        decide: () => ({
          type: "ask_human" as const,
          interrupt: {
            interruptId: "interrupt-unbound",
            reason: "high_risk_action" as const,
            summary: "请确认高风险操作",
            evidenceRefs: [],
            proposedAction: { stepId: "submit", kind: "high_risk_action" },
            expiresAt: "2026-09-02T01:00:00.000Z"
          }
        })
      },
      idFactory: () => "run-unbound-approval",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "直接提交", requestedBy: "user-1" });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("runtime_approval_binding_invalid");
  });

  it("preserves a planner approval failure instead of dispatching a partial plan", async () => {
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      planner: {
        create: async () => ({
          planId: "plan-invalid-approval",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("prepare", "medium")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      idFactory: () => "run-invalid-approval",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "直接提交", requestedBy: "user-1" });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("runtime_plan_approval_missing");
  });

  it("rejects a planner that marks work completed before dispatch", async () => {
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => ({
        ...resolved,
        intent: {
          ...intent,
          primaryGoal: "analyze_resume",
          subGoals: ["review_result"],
          riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
          autonomyLevel: "prepare"
        }
      }) },
      planner: {
        create: async () => ({
          planId: "plan-precompleted",
          intentId: "intent-1",
          revision: 1,
          steps: [{ ...applicationStep("precompleted", "low"), status: "completed" as const }],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      idFactory: () => "run-precompleted",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "分析简历", requestedBy: "user-1" });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("runtime_plan_step_invalid");
  });

  it("keeps the run creation timestamp stable across later checkpoints", async () => {
    let currentTime = "2026-09-02T00:00:00.000Z";
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      planner: {
        create: async () => ({
          planId: "plan-timestamp",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("submit", "irreversible")],
          assumptions: [],
          approvalPoints: [{ id: "approval-submit", kind: "final_submit", stepId: "submit", required: true }],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      idFactory: () => "run-timestamp",
      now: () => currentTime
    });

    const first = await runtime.start({ goal: "直接提交", requestedBy: "user-1" });
    currentTime = "2026-09-02T00:01:00.000Z";
    await runtime.cancel(first.runId);

    expect((await runtime.inspect(first.runId)).checkpoint.createdAt).toBe("2026-09-02T00:00:00.000Z");
  });

  it("fails closed when restoring an in-flight step after a process restart", async () => {
    let release: (() => void) | undefined;
    let executorStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { executorStarted = resolve; });
    const checkpointStore = createRuntimeCheckpointStore();
    const artifactStore = createInMemoryArtifactStore();
    const dependencies = {
      intentResolver: {
        resolve: async (): Promise<IntentResolution> => ({
          ...resolved,
          intent: {
            ...intent,
            primaryGoal: "analyze_resume",
            subGoals: ["review_result"],
            riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
            autonomyLevel: "prepare"
          }
        })
      },
      planner: {
        create: async () => ({
          planId: "plan-inflight",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("inflight", "low")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      executor: {
        execute: async () => {
          executorStarted?.();
          await new Promise<void>((resolve) => { release = resolve; });
          return { status: "completed" as const };
        }
      },
      checkpointStore,
      artifactStore,
      idFactory: () => "run-inflight",
      now: () => "2026-09-02T00:00:00.000Z"
    } as const;

    const firstRuntime = createAgentRuntime(dependencies);
    const running = firstRuntime.start({ goal: "分析简历", requestedBy: "user-1" });
    await started;
    expect((await checkpointStore.latest("run-inflight"))?.status).toBe("running");

    const restartedRuntime = createAgentRuntime({
      intentResolver: dependencies.intentResolver,
      planner: dependencies.planner,
      checkpointStore,
      artifactStore,
      idFactory: () => "unused",
      now: dependencies.now
    });
    const snapshot = await restartedRuntime.inspect("run-inflight");
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.checkpoint.status).toBe("blocked");
    expect(snapshot.checkpoint.currentStepId).toBe("inflight");

    await firstRuntime.cancel("run-inflight");
    release?.();
    await running;
  });

  it("blocks a restored run whose persisted budget is already exhausted", async () => {
    const checkpointStore = createRuntimeCheckpointStore();
    await checkpointStore.save({
      version: "2.0.0",
      runId: "run-restored-budget",
      executionEpoch: 0,
      status: "running",
      memoryRefs: [],
      evidenceRefs: [],
      budget: { steps: 2, toolCalls: 0, retries: 0, replans: 0, tokens: 0, elapsedMs: 0 },
      completedActionIds: [],
      stateHash: "a".repeat(64),
      createdAt: "2026-09-02T00:00:00.000Z"
    });
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      checkpointStore,
      budgetLimits: { maxSteps: 1 },
      idFactory: () => "unused",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const snapshot = await runtime.inspect("run-restored-budget");
    expect(snapshot.status).toBe("blocked");
    expect(snapshot.checkpoint.status).toBe("blocked");
  });

  it("rejects a checkpoint whose intent and plan identities do not match", async () => {
    const checkpointStore = createRuntimeCheckpointStore();
    const artifactStore = createInMemoryArtifactStore();
    const intentRef = artifactStore.saveIntent(intent);
    const mismatchedPlan = {
      planId: "plan-other",
      intentId: "intent-other",
      revision: 1,
      steps: [applicationStep("safe", "low")],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z"
    };
    const planRef = artifactStore.savePlan(mismatchedPlan);
    await checkpointStore.save({
      version: "2.0.0",
      runId: "run-identity-mismatch",
      intentId: intent.intentId,
      planId: mismatchedPlan.planId,
      planRevision: mismatchedPlan.revision,
      executionEpoch: 0,
      phase: "dispatch",
      status: "running",
      intentRef,
      planRef,
      memoryRefs: [],
      evidenceRefs: [],
      budget: { steps: 0, toolCalls: 0, retries: 0, replans: 0, tokens: 0, elapsedMs: 0 },
      budgetLimits: {
        maxAttemptsPerStep: 2,
        maxRetries: 64,
        maxReplans: 8,
        maxSteps: 32,
        maxToolCalls: 64,
        maxTokens: 100_000,
        maxDurationMs: 900_000
      },
      completedActionIds: [],
      stateHash: "a".repeat(64),
      createdAt: "2026-09-02T00:00:00.000Z"
    });

    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      checkpointStore,
      artifactStore,
      idFactory: () => "unused",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    await expect(runtime.inspect("run-identity-mismatch"))
      .rejects.toThrow("agent_checkpoint_identity_mismatch");
  });

  it("does not persist human resume values in the LangGraph checkpoint", async () => {
    const langGraphCheckpointer = new MemorySaver();
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      planner: {
        create: async () => ({
          planId: "plan-opaque-resume",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("submit", "irreversible")],
          assumptions: [],
          approvalPoints: [{ id: "approval-submit", kind: "final_submit", stepId: "submit", required: true }],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      langGraphCheckpointer,
      idFactory: (() => {
        let index = 0;
        return () => `opaque-${++index}`;
      })(),
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const first = await runtime.start({ goal: "直接提交", requestedBy: "user-1" });
    await runtime.resume(first.runId, {
      interruptId: first.pendingInterrupt!.interruptId,
      action: "approve",
      values: { password: "LEAK-ME-NOT" }
    });

    const writes = (langGraphCheckpointer as unknown as { writes: unknown }).writes;
    const matches: string[] = [];
    const decoder = new TextDecoder();
    const walk = (value: unknown, path = "writes"): void => {
      if (typeof value === "string") {
        if (value.includes("LEAK")) matches.push(`${path}:${value}`);
        return;
      }
      if (value instanceof Uint8Array) {
        const decoded = decoder.decode(value);
        if (decoded.includes("LEAK")) matches.push(`${path}:${decoded}`);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (typeof value === "object" && value !== null) {
        Object.entries(value).forEach(([key, item]) => walk(item, `${path}.${key}`));
      }
    };
    walk(writes);
    expect(matches).toEqual([]);
  });

  it("executes the approved irreversible step and passes the approval context to the executor", async () => {
    let executorCalls = 0;
    let executorInput: RuntimeExecutorInput | undefined;
    const approvals = createApprovalSystem({
      signingKey: Buffer.alloc(32, 20),
      verifyHumanPrincipal: () => ({ subject: "user-1" }),
      idFactory: () => "approval-executor",
      now: () => "2026-09-02T00:00:00.000Z"
    });
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      planner: {
        create: async () => ({
          planId: "plan-approved-execution",
          intentId: "intent-1",
          revision: 1,
          steps: [{
            ...applicationStep("submit", "irreversible"),
            approvalBinding: {
              snapshotId: "snapshot-executor",
              targetFingerprint: "target-executor",
              payloadHash: "d".repeat(64)
            }
          }],
          assumptions: [],
          approvalPoints: [{ id: "approval-submit", kind: "final_submit", stepId: "submit", required: true }],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      executor: {
        execute: async (input) => {
          executorCalls += 1;
          executorInput = input;
          return { status: "completed" as const };
        }
      },
      idFactory: (() => {
        let index = 0;
        return () => `approved-${++index}`;
      })(),
      now: () => "2026-09-02T00:00:00.000Z",
      approvalGate: approvals.gate
    });

    const first = await runtime.start({ goal: "直接提交", requestedBy: "user-1" });
    const approval = approvals.issuer.issue({
      binding: {
        runId: first.runId,
        planRevision: 1,
        executionEpoch: 0,
        snapshotId: "snapshot-executor",
        targetFingerprint: "target-executor",
        payloadHash: "d".repeat(64)
      },
      principal: { subject: "user-1" }
    });
    const resumed = await runtime.resume(first.runId, {
      interruptId: first.pendingInterrupt!.interruptId,
      action: "approve",
      values: { approval }
    });

    expect(resumed.status).toBe("completed");
    expect(executorCalls).toBe(1);
    expect(executorInput?.step.id).toBe("submit");
    expect(executorInput?.decision.type).toBe("dispatch_agent");
    expect(executorInput?.humanResume?.values).toEqual({ approval });
  });

  it("treats final submit rejection and cancellation as terminal user decisions", async () => {
    const createApprovalRuntime = () => createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      planner: {
        create: async () => ({
          planId: "plan-approval-terminal",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("submit", "irreversible")],
          assumptions: [],
          approvalPoints: [{ id: "approval-submit", kind: "final_submit", stepId: "submit", required: true }],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      idFactory: (() => {
        let index = 0;
        return () => `approval-terminal-${++index}`;
      })(),
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const rejectedRuntime = createApprovalRuntime();
    const rejected = await rejectedRuntime.start({ goal: "直接提交", requestedBy: "user-1" });
    await expect(rejectedRuntime.resume(rejected.runId, {
      interruptId: rejected.pendingInterrupt!.interruptId,
      action: "reject",
      values: {}
    })).resolves.toMatchObject({ status: "blocked" });

    const cancelledRuntime = createApprovalRuntime();
    const cancelled = await cancelledRuntime.start({ goal: "直接提交", requestedBy: "user-1" });
    await expect(cancelledRuntime.resume(cancelled.runId, {
      interruptId: cancelled.pendingInterrupt!.interruptId,
      action: "cancel",
      values: {}
    })).resolves.toMatchObject({ status: "cancelled" });
  });

  it("persists a completed executor output reference on its plan step", async () => {
    const artifactStore = createInMemoryArtifactStore();
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => ({
        ...resolved,
        intent: {
          ...intent,
          primaryGoal: "analyze_resume",
          subGoals: ["review_result"],
          riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
          autonomyLevel: "prepare"
        }
      }) },
      planner: {
        create: async () => ({
          planId: "plan-output-ref",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("review", "low")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      executor: { execute: async () => ({ status: "completed" as const, outputRef: "output:review:1" }) },
      artifactStore,
      idFactory: () => "run-output-ref",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "分析简历", requestedBy: "user-1" });
    const snapshot = await runtime.inspect(result.runId);
    const plan = artifactStore.getPlan(snapshot.checkpoint.planRef!);

    expect(result.status).toBe("completed");
    expect(plan?.steps[0]?.outputRefs).toContain("output:review:1");
  });

  it("fails closed when an executor returns a schema-invalid result", async () => {
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => ({
        ...resolved,
        intent: {
          ...intent,
          primaryGoal: "analyze_resume",
          subGoals: ["review_result"],
          riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
          autonomyLevel: "prepare"
        }
      }) },
      planner: {
        create: async () => ({
          planId: "plan-invalid-executor",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("review", "low")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      executor: {
        execute: async () => ({ status: "completed", toolCallsUsed: Number.NaN } as never)
      },
      idFactory: () => "run-invalid-executor",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "分析简历", requestedBy: "user-1" });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("runtime_executor_result_invalid");
  });

  it("fails closed when the intent resolver returns an unknown resolution shape", async () => {
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async () => ({ type: "unexpected" } as never) },
      idFactory: () => "run-invalid-intent-resolution",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "分析简历", requestedBy: "user-1" });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("runtime_intent_resolution_invalid");
  });

  it("aborts an intent resolver when the wall-time budget expires", async () => {
    let signal: AbortSignal | undefined;
    const runtime = createAgentRuntime({
      intentResolver: {
        resolve: async (_input, _context, operation) => {
          signal = operation?.signal;
          await new Promise((resolve) => setTimeout(resolve, 40));
          return resolved;
        }
      },
      budgetLimits: { maxDurationMs: 15 },
      idFactory: () => "run-intent-deadline",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "分析简历", requestedBy: "user-1" });

    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("budget_duration_exceeded");
    expect(signal?.aborted).toBe(true);
  });

  it("aborts a planner when the wall-time budget expires", async () => {
    let signal: AbortSignal | undefined;
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => ({
        ...resolved,
        intent: {
          ...intent,
          primaryGoal: "analyze_resume",
          subGoals: ["review_result"],
          riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
          autonomyLevel: "prepare"
        }
      }) },
      planner: {
        create: async (_intent, _input, operation) => {
          signal = operation?.signal;
          await new Promise((resolve) => setTimeout(resolve, 40));
          return {
            planId: "plan-planner-deadline",
            intentId: "intent-1",
            revision: 1,
            steps: [applicationStep("review", "low")],
            assumptions: [],
            approvalPoints: [],
            estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
            createdAt: "2026-09-02T00:00:00.000Z",
            updatedAt: "2026-09-02T00:00:00.000Z"
          };
        }
      },
      budgetLimits: { maxDurationMs: 15 },
      idFactory: () => "run-planner-deadline",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "分析简历", requestedBy: "user-1" });

    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("budget_duration_exceeded");
    expect(signal?.aborted).toBe(true);
  });

  it("aborts a supervisor when the wall-time budget expires", async () => {
    let signal: AbortSignal | undefined;
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => ({
        ...resolved,
        intent: {
          ...intent,
          primaryGoal: "analyze_resume",
          subGoals: ["review_result"],
          riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
          autonomyLevel: "prepare"
        }
      }) },
      planner: {
        create: async () => ({
          planId: "plan-supervisor-deadline",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("review", "low")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      supervisor: {
        decide: async ({ signal: operationSignal }) => {
          signal = operationSignal;
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { type: "dispatch_agent" as const, agent: "review_agent", input: {}, reason: "review" };
        }
      },
      budgetLimits: { maxDurationMs: 15 },
      idFactory: () => "run-supervisor-deadline",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "分析简历", requestedBy: "user-1" });

    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("budget_duration_exceeded");
    expect(signal?.aborted).toBe(true);
  });

  it("requires a final-submit approval point for every irreversible plan step", async () => {
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => ({
        ...resolved,
        intent: {
          ...intent,
          primaryGoal: "analyze_resume",
          subGoals: ["review_result"],
          riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
          autonomyLevel: "prepare"
        }
      }) },
      planner: {
        create: async () => ({
          planId: "plan-irreversible-without-approval",
          intentId: "intent-1",
          revision: 1,
          steps: [applicationStep("submit", "irreversible")],
          assumptions: [],
          approvalPoints: [],
          estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z"
        })
      },
      idFactory: () => "run-irreversible-without-approval",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "分析简历", requestedBy: "user-1" });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("runtime_plan_approval_missing");
  });

  it("fails closed when a checkpoint hash does not match its persisted phase and budget", async () => {
    const checkpointStore = createRuntimeCheckpointStore();
    await checkpointStore.save({
      version: "2.0.0",
      runId: "run-tampered-checkpoint",
      executionEpoch: 0,
      phase: "plan",
      status: "running",
      memoryRefs: [],
      evidenceRefs: [],
      budget: { steps: 0, toolCalls: 0, retries: 0, replans: 0, tokens: 0, elapsedMs: 0 },
      budgetLimits: {
        maxAttemptsPerStep: 2,
        maxRetries: 64,
        maxReplans: 8,
        maxSteps: 32,
        maxToolCalls: 80,
        maxTokens: 100_000,
        maxDurationMs: 900_000
      },
      completedActionIds: [],
      stateHash: "a".repeat(64),
      createdAt: "2026-09-02T00:00:00.000Z"
    });
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      checkpointStore,
      idFactory: () => "unused",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const snapshot = await runtime.inspect("run-tampered-checkpoint");

    expect(snapshot.status).toBe("blocked");
    expect(snapshot.checkpoint.status).toBe("blocked");
    expect(snapshot.checkpoint.phase).toBe("blocked");
  });

  it("recovers a safe running checkpoint at a graph boundary after a process restart", async () => {
    const checkpointStore = createRuntimeCheckpointStore();
    const artifactStore = createInMemoryArtifactStore();
    const plan = {
      planId: "plan-recover-boundary",
      intentId: intent.intentId,
      revision: 1,
      steps: [applicationStep("review", "low")],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1000 },
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z"
    };
    const intentRef = artifactStore.saveIntent(intent);
    const planRef = artifactStore.savePlan(plan);
    const restoredState = {
      runId: "run-recover-boundary",
      requestedBy: "restored",
      status: "running" as const,
      phase: "dispatch" as const,
      executionEpoch: 0,
      intent,
      plan,
      intentRef,
      planRef,
      budget: { steps: 0, toolCalls: 0, retries: 0, replans: 0, tokens: 0, elapsedMs: 0 },
      budgetLimits: {
        maxAttemptsPerStep: 2,
        maxRetries: 64,
        maxReplans: 8,
        maxSteps: 32,
        maxToolCalls: 80,
        maxTokens: 100_000,
        maxDurationMs: 900_000
      },
      memoryRefs: [],
      evidenceRefs: [],
      completedActionIds: [],
      stateHash: "0".repeat(64),
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z"
    } satisfies RuntimeState;
    const hash = stateHash(restoredState);
    await checkpointStore.save({
      version: "2.0.0",
      runId: restoredState.runId,
      intentId: intent.intentId,
      planId: plan.planId,
      planRevision: plan.revision,
      executionEpoch: 0,
      phase: "dispatch",
      status: "running",
      intentRef,
      planRef,
      memoryRefs: [],
      evidenceRefs: [],
      budget: restoredState.budget,
      budgetLimits: restoredState.budgetLimits,
      completedActionIds: [],
      stateHash: hash,
      createdAt: restoredState.createdAt
    });

    const runtime = createAgentRuntime({
      intentResolver: { resolve: async (): Promise<IntentResolution> => resolved },
      checkpointStore,
      artifactStore,
      idFactory: () => "unused",
      now: () => "2026-09-02T00:00:00.000Z"
    });

    const result = await runtime.recover(restoredState.runId);

    expect(result.status).toBe("completed");
  });

});
