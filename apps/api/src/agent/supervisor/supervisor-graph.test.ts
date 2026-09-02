import { describe, expect, it, vi } from "vitest";
import { Command } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { CanonicalIntentSchema, PlanStateSchema } from "@resume/contracts";
import { z } from "zod";
import { createCapabilityCatalog } from "../capabilities/catalog.js";
import { defineCapability } from "../capabilities/descriptor.js";
import { createApprovalSystem } from "../policy/approval-gate.js";
import { createCallerAttestationAuthority } from "../policy/caller-attestation.js";
import { createPolicyEngine } from "../policy/policy-engine.js";
import { createSupervisorGraph } from "./supervisor-graph.js";
import { createPlanValidator } from "./plan-validator.js";
import { createPlanner } from "./planner.js";
import { createReplanner } from "./replanner.js";
import { createSupervisor } from "./supervisor.js";
import { createMainGraph } from "../main-graph.js";
import { intentForApplication } from "./planner.test.js";

const intentWithFinalGate = CanonicalIntentSchema.parse({
  ...intentForApplication,
  subGoals: ["prepare_application"],
  riskProfile: { level: "low" as const, requiresHumanApproval: true, reasons: ["explicit final review"] }
});

describe("SupervisorGraph", () => {
  it("exposes the supervisor loop as the main application graph", async () => {
    const graph = createMainGraph({
      planner: createPlanner({ idFactory: () => "main-plan", now: () => "2026-09-03T00:00:00.000Z" }),
      supervisor: createSupervisor({ idFactory: () => "main-interrupt", now: () => "2026-09-03T00:00:00.000Z" }),
      planValidator: createPlanValidator(),
      agents: { application_agent: { execute: async ({ step }) => ({
        status: "completed" as const,
        evidenceRefs: ["evidence-main"],
        satisfiedCriteria: step.acceptanceCriteria
      }) } },
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "main-run",
      intent: intentWithFinalGate,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "main-run" } });

    expect(result.status).toBe("interrupted");
  });

  it("routes an irreversible step to a human gate before completion", async () => {
    const graph = createSupervisorGraph({
      planner: createPlanner({ idFactory: () => "plan-id", now: () => "2026-09-03T00:00:00.000Z" }),
      supervisor: createSupervisor({ idFactory: () => "interrupt-id", now: () => "2026-09-03T00:00:00.000Z" }),
      planValidator: createPlanValidator(),
      agents: {
        application_agent: { execute: async ({ step }) => ({
          status: "completed" as const,
          evidenceRefs: ["evidence-final"],
          satisfiedCriteria: step.acceptanceCriteria
        }) }
      },
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "run-1",
      intent: intentWithFinalGate,
      evidenceRefs: [],
      iteration: 0
    }, { configurable: { thread_id: "run-1" } });

    expect(result.status).toBe("interrupted");
    expect(result.pendingInterrupt?.reason).toBe("final_submit");
  });

  it("does not allow a completed decision without evidence references", async () => {
    const graph = createSupervisorGraph({
      planner: {
        create: async () => ({
          planId: "plan-1", intentId: "intent-empty", revision: 1,
          steps: [], assumptions: [], approvalPoints: [],
          estimatedCost: { steps: 0, toolCalls: 0, tokens: 0, durationMs: 0 },
          createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z"
        })
      },
      supervisor: { decide: async () => ({ type: "finish", outcome: "completed", summary: "done" }) },
      planValidator: createPlanValidator(),
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "run-2",
      intent: { ...intentForApplication, intentId: "intent-empty" },
      evidenceRefs: [],
      iteration: 0
    }, { configurable: { thread_id: "run-2" } });

    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("evidence_required_for_completion");
  });

  it("fails closed when approval is followed by a direct high-risk specialist dispatch", async () => {
    const plan = PlanStateSchema.parse({
      planId: "plan-approval",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "prepare",
        objective: "prepare application",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["prepared"],
        risk: "high"
      }],
      assumptions: [],
      approvalPoints: [{ id: "approval:prepare", kind: "high_risk_action", stepId: "prepare", required: true }],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const execute = vi.fn(async () => ({
      status: "completed" as const,
      outputRef: "output:prepare",
      evidenceRefs: ["evidence-prepare"],
      satisfiedCriteria: ["prepared"]
    }));
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: createSupervisor({ idFactory: () => "approval-id", now: () => "2026-09-03T00:00:00.000Z" }),
      planValidator: createPlanValidator(),
      agents: { application_agent: { execute } },
      checkpointer: new MemorySaver()
    });
    const config = { configurable: { thread_id: "approval-run" } };
    const first = await graph.invoke({
      runId: "approval-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, config);
    expect(first.status).toBe("interrupted");
    expect(first.pendingInterrupt?.reason).toBe("high_risk_action");

    const second = await graph.invoke(new Command({
      resume: { interruptId: first.pendingInterrupt!.interruptId, action: "confirm", values: {} }
    }), config);
    expect(execute).not.toHaveBeenCalled();
    expect(second.plan?.steps[0]?.status).toBe("pending");
    expect(second.status).toBe("blocked");
    expect(second.error?.code).toBe("specialist_direct_risk_forbidden");
  });

  it("authorizes a low-risk tool once and passes its permit to the catalog", async () => {
    let calls = 0;
    const catalog = createCapabilityCatalog([defineCapability({
      descriptor: {
        name: "data.read",
        version: "1.0.0",
        kind: "read",
        risk: "low",
        sideEffect: "none",
        allowedCallers: ["graph"],
        requiresApproval: false,
        idempotency: "idempotent",
        timeoutMs: 5_000
      },
      inputSchema: z.object({
        stepId: z.string(),
        intentId: z.string(),
        planRevision: z.number().int().positive(),
        inputRefs: z.array(z.string())
      }).strict(),
      outputSchema: z.object({ ok: z.boolean() }).strict(),
      handler: async () => { calls += 1; return { ok: true }; }
    })]);
    const callerAttestations = createCallerAttestationAuthority({ signingKey: Buffer.alloc(32, 37) });
    const policy = createPolicyEngine({
      catalog,
      approvalGate: createApprovalSystem({
        signingKey: Buffer.alloc(32, 5),
        verifyHumanPrincipal: () => ({ subject: "user-1" })
      }).gate,
      callerAttestationVerifier: callerAttestations.verifier
    });
    const plan = PlanStateSchema.parse({
      planId: "plan-tool",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "read-step",
        objective: "read profile",
        owner: "resume",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["read"],
        risk: "low",
        capabilityNames: ["data.read"]
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 1, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: createSupervisor({ now: () => "2026-09-03T00:00:00.000Z" }),
      planValidator: createPlanValidator({ capabilityNames: ["data.read"] }),
      catalog,
      policy,
      callerAttestation: callerAttestations.issuer.issue("graph"),
      checkpointer: new MemorySaver()
    });
    const result = await graph.invoke({
      runId: "tool-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "tool-run" } });
    expect(calls).toBe(1);
    expect(result.plan?.steps[0]?.status).toBe("completed");
    expect(result.status).toBe("completed");
  });

  it("blocks a supervisor decision that targets a different step", async () => {
    const execute = vi.fn(async () => ({ status: "completed" as const }));
    const plan = PlanStateSchema.parse({
      planId: "plan-binding",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "expected-step",
        objective: "prepare application",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["prepared"],
        risk: "low"
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: {
        decide: async () => ({
          type: "dispatch_agent" as const,
          agent: "application_agent",
          input: { stepId: "unexpected-step" },
          reason: "malformed binding"
        })
      },
      planValidator: createPlanValidator(),
      agents: { application_agent: { execute } },
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "binding-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "binding-run" } });

    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("decision_step_mismatch");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not mark a plan with an unsatisfied dependency as completed", async () => {
    const plan = PlanStateSchema.parse({
      planId: "plan-deadlock",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "blocked-prerequisite",
        objective: "blocked prerequisite",
        owner: "resume",
        status: "blocked",
        dependsOn: [],
        inputRefs: [],
        outputRefs: [],
        attempt: 1,
        maxAttempts: 1,
        acceptanceCriteria: ["prepared"],
        risk: "low"
      }, {
        id: "waiting-step",
        objective: "waiting step",
        owner: "application",
        status: "pending",
        dependsOn: ["blocked-prerequisite"],
        inputRefs: [],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["prepared"],
        risk: "low"
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 2, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: { decide: async () => ({ type: "finish" as const, outcome: "completed" as const, summary: "done" }) },
      planValidator: createPlanValidator(),
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "deadlock-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "deadlock-run" } });

    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("plan_deadlock");
  });

  it("surfaces a replanner failure as a terminal blocked result", async () => {
    const plan = PlanStateSchema.parse({
      planId: "plan-replan-failure",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "retry-step",
        objective: "retry step",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["prepared"],
        risk: "low"
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: createSupervisor({ now: () => "2026-09-03T00:00:00.000Z" }),
      planValidator: createPlanValidator(),
      agents: { application_agent: {
        execute: async () => ({ status: "blocked" as const, errorCode: "stale_snapshot" })
      } },
      replanner: { replan: async () => { throw new Error("replanner unavailable"); } },
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "replan-failure-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "replan-failure-run" } });

    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("replan_failed");
  });

  it("checkpoints a running attempt before invoking an external agent", async () => {
    let release!: () => void;
    const execution = new Promise<void>((resolve) => { release = resolve; });
    const plan = PlanStateSchema.parse({
      planId: "plan-running",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "running-step",
        objective: "prepare application",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["prepared"],
        risk: "low"
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const checkpointer = new MemorySaver();
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: {
        decide: async ({ readyStep, intent, plan }) => ({
          type: "dispatch_agent" as const,
          agent: "application_agent",
          input: {
            stepId: readyStep!.id,
            intentId: intent!.intentId,
            planRevision: plan!.revision,
            inputRefs: readyStep!.inputRefs
          },
          reason: "run step"
        })
      },
      planValidator: createPlanValidator(),
      agents: { application_agent: { execute: async ({ step }) => {
        await execution;
        return {
          status: "completed" as const,
          evidenceRefs: ["evidence-running"],
          satisfiedCriteria: step.acceptanceCriteria
        };
      } } },
      checkpointer
    });
    const config = { configurable: { thread_id: "running-run" } };
    const running = graph.invoke({
      runId: "running-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, config);

    try {
      await vi.waitFor(async () => {
        const snapshot = await graph.getState(config);
        const step = (snapshot.values.plan as typeof plan | undefined)?.steps[0];
        expect(step?.status).toBe("running");
        expect(step?.attemptToken).toBe("attempt:running-run:plan-running:1:running-step:1");
      });
    } finally {
      release();
    }
    await running;
  });

  it("does not dispatch a running attempt recovered from a checkpoint", async () => {
    const execute = vi.fn(async () => ({ status: "completed" as const }));
    const plan = PlanStateSchema.parse({
      planId: "plan-recovered-running",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "recovered-step",
        objective: "prepare application",
        owner: "application",
        status: "running",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        attemptToken: "attempt:recovered-run:1:recovered-step:1",
        maxAttempts: 1,
        acceptanceCriteria: ["prepared"],
        risk: "low"
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: { decide: async () => ({ type: "dispatch_agent" as const, agent: "application_agent", input: { stepId: "recovered-step" }, reason: "must not run" }) },
      planValidator: createPlanValidator(),
      agents: { application_agent: { execute } },
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "recovered-run",
      intent: intentForApplication,
      plan,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "recovered-run" } });

    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("plan_deadlock");
    expect(execute).not.toHaveBeenCalled();
  });

  it("clears an old approval when replanning the same step", async () => {
    const plan = PlanStateSchema.parse({
      planId: "plan-replan-approval",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "approval-step",
        objective: "verify application",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["verified"],
        risk: "high"
      }],
      assumptions: [],
      approvalPoints: [{ id: "approval:approval-step", kind: "high_risk_action", stepId: "approval-step", required: true }],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const execute = vi.fn(async () => ({ status: "blocked" as const, errorCode: "stale_snapshot" }));
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: createSupervisor({ idFactory: () => "replan-approval", now: () => "2026-09-03T00:00:00.000Z" }),
      planValidator: createPlanValidator(),
      agents: { application_agent: { execute } },
      replanner: createReplanner({ now: () => "2026-09-03T00:01:00.000Z" }),
      checkpointer: new MemorySaver()
    });
    const config = { configurable: { thread_id: "replan-approval-run" } };
    const first = await graph.invoke({
      runId: "replan-approval-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, config);
    expect(first.status).toBe("interrupted");

    const second = await graph.invoke(new Command({
      resume: { interruptId: first.pendingInterrupt!.interruptId, action: "confirm", values: {} }
    }), config);

    expect(execute).not.toHaveBeenCalled();
    expect(second.status).toBe("blocked");
    expect(second.error?.code).toBe("specialist_direct_risk_forbidden");
  });

  it("rejects expired and non-confirming human approvals", async () => {
    const plan = PlanStateSchema.parse({
      planId: "plan-expired-approval",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "expired-step",
        objective: "verify application",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["verified"],
        risk: "high"
      }],
      assumptions: [],
      approvalPoints: [{ id: "approval:expired-step", kind: "high_risk_action", stepId: "expired-step", required: true }],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: {
        decide: async () => ({
          type: "ask_human" as const,
          interrupt: {
            interruptId: "expired-approval",
            reason: "high_risk_action" as const,
            summary: "confirm",
            evidenceRefs: [],
            proposedAction: {
              kind: "high_risk_action",
              runId: "expired-run",
              stepId: "expired-step",
              planRevision: 1,
              executionEpoch: 0
            },
            expiresAt: "2026-09-02T23:59:00.000Z"
          }
        })
      },
      planValidator: createPlanValidator(),
      checkpointer: new MemorySaver(),
      now: () => "2026-09-03T00:00:00.000Z"
    });
    const config = { configurable: { thread_id: "expired-run" } };
    const first = await graph.invoke({
      runId: "expired-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, config);
    expect(first.status).toBe("interrupted");

    const expired = await graph.invoke(new Command({
      resume: { interruptId: "expired-approval", action: "confirm", values: {} }
    }), config);
    expect(expired.status).toBe("blocked");
    expect(expired.error?.code).toBe("approval_expired");
  });

  it("binds a dispatch decision to intent, revision, inputs, and the step owner", async () => {
    const execute = vi.fn(async () => ({ status: "completed" as const }));
    const plan = PlanStateSchema.parse({
      planId: "plan-decision-binding",
      intentId: intentForApplication.intentId,
      revision: 3,
      steps: [{
        id: "binding-step",
        objective: "prepare application",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId, "snapshot:1"],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["prepared"],
        risk: "low"
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: {
        decide: async () => ({
          type: "dispatch_agent" as const,
          agent: "review_agent",
          input: {
            stepId: "binding-step",
            intentId: "wrong-intent",
            planRevision: 99,
            inputRefs: ["forged-input"]
          },
          reason: "forged binding"
        })
      },
      planValidator: createPlanValidator(),
      agents: { review_agent: { execute } },
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "decision-binding-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "decision-binding-run" } });

    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("decision_intent_mismatch");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a dispatch decision whose agent does not own the step", async () => {
    const execute = vi.fn(async () => ({ status: "completed" as const }));
    const plan = PlanStateSchema.parse({
      planId: "plan-owner-binding",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "owner-step",
        objective: "prepare application",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["prepared"],
        risk: "low"
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: {
        decide: async () => ({
          type: "dispatch_agent" as const,
          agent: "review_agent",
          input: {
            stepId: "owner-step",
            intentId: intentForApplication.intentId,
            planRevision: 1,
            inputRefs: [intentForApplication.intentId]
          },
          reason: "wrong owner"
        })
      },
      planValidator: createPlanValidator(),
      agents: { review_agent: { execute } },
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "owner-binding-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "owner-binding-run" } });

    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("decision_agent_mismatch");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a replan that changes intent or breaks revision continuity", async () => {
    const plan = PlanStateSchema.parse({
      planId: "plan-replan-binding",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "replan-step",
        objective: "prepare application",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 2,
        acceptanceCriteria: ["prepared"],
        risk: "low"
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: createSupervisor({ now: () => "2026-09-03T00:00:00.000Z" }),
      planValidator: createPlanValidator(),
      agents: { application_agent: {
        execute: async () => ({ status: "blocked" as const, errorCode: "stale_snapshot", retryable: true })
      } },
      replanner: {
        replan: async () => PlanStateSchema.parse({
          ...plan,
          planId: "forged-plan",
          intentId: "forged-intent",
          revision: 7,
          previousRevision: 6,
          revisionHistory: []
        })
      },
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "replan-binding-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "replan-binding-run" } });

    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("replan_intent_mismatch");
  });

  it("accepts a legal truncated revision history at the history limit", async () => {
    const planId = "plan-replan-history-limit";
    const revisionHistory = Array.from({ length: 100 }, (_, index) => ({
      revision: index + 1,
      planRef: `plan:${planId}:${index + 1}`,
      reason: "previous replan",
      createdAt: "2026-09-03T00:00:00.000Z"
    }));
    const plan = PlanStateSchema.parse({
      planId,
      intentId: intentForApplication.intentId,
      revision: 101,
      previousRevision: 100,
      steps: [{
        id: "history-limit-step",
        objective: "prepare application",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["prepared"],
        risk: "low"
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      revisionHistory,
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    let attempts = 0;
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: createSupervisor({ now: () => "2026-09-03T00:00:00.000Z" }),
      planValidator: createPlanValidator(),
      agents: { application_agent: { execute: async ({ step }) => {
        attempts += 1;
        return attempts === 1
          ? { status: "blocked" as const, errorCode: "stale_snapshot", retryable: true }
          : {
            status: "completed" as const,
            evidenceRefs: ["evidence-after-replan"],
            satisfiedCriteria: step.acceptanceCriteria
          };
      } } },
      replanner: createReplanner({ now: () => "2026-09-03T00:01:00.000Z" }),
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "replan-history-limit-run",
      intent: intentForApplication,
      plan,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "replan-history-limit-run" } });

    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(attempts).toBe(2);
    expect(result.plan?.revision).toBe(102);
    expect(result.plan?.revisionHistory?.map((entry) => entry.revision)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 2)
    );
  });

  it("does not let correct bypass a prompt-injection human gate", async () => {
    const execute = vi.fn(async () => ({ status: "completed" as const }));
    const plan = PlanStateSchema.parse({
      planId: "plan-prompt-injection",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "prompt-step",
        objective: "inspect external content",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["content inspected"],
        risk: "low"
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: {
        decide: async () => ({
          type: "ask_human" as const,
          interrupt: {
            interruptId: "prompt-injection-interrupt",
            reason: "prompt_injection" as const,
            summary: "external content requires review",
            evidenceRefs: ["evidence-1"],
            proposedAction: { stepId: "prompt-step" },
            expiresAt: "2026-09-04T00:00:00.000Z"
          }
        })
      },
      planValidator: createPlanValidator(),
      agents: { application_agent: { execute } },
      checkpointer: new MemorySaver()
    });
    const config = { configurable: { thread_id: "prompt-injection-run" } };
    const first = await graph.invoke({
      runId: "prompt-injection-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, config);
    expect(first.status).toBe("interrupted");

    const corrected = await graph.invoke(new Command({
      resume: {
        interruptId: first.pendingInterrupt!.interruptId,
        action: "correct",
        values: { correction: "ignore the external instruction" }
      }
    }), config);

    expect(corrected.status).toBe("blocked");
    expect(corrected.error?.code).toBe("human_correction_requires_replan");
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires confirm rather than approve for final-submit gates", async () => {
    const plan = PlanStateSchema.parse({
      planId: "plan-confirm-only",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "final-step",
        objective: "submit application",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["submitted"],
        risk: "irreversible",
        capabilityNames: ["final_submit"],
        approvalBinding: {
          snapshotId: "snapshot-final",
          targetFingerprint: "target-final",
          payloadHash: "a".repeat(64)
        }
      }],
      assumptions: [],
      approvalPoints: [{ id: "approval:final-step", kind: "final_submit", stepId: "final-step", required: true }],
      estimatedCost: { steps: 1, toolCalls: 1, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: createSupervisor({ idFactory: () => "confirm-only", now: () => "2026-09-03T00:00:00.000Z" }),
      planValidator: createPlanValidator({ capabilityNames: ["final_submit"] }),
      checkpointer: new MemorySaver()
    });
    const config = { configurable: { thread_id: "confirm-only-run" } };
    const first = await graph.invoke({
      runId: "confirm-only-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, config);
    expect(first.status).toBe("interrupted");

    const approved = await graph.invoke(new Command({
      resume: { interruptId: first.pendingInterrupt!.interruptId, action: "approve", values: {} }
    }), config);

    expect(approved.status).toBe("blocked");
    expect(approved.error?.code).toBe("approval_action_invalid");
  });

  it("blocks irreversible approval interrupts without a complete binding", async () => {
    const plan = PlanStateSchema.parse({
      planId: "plan-missing-binding",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "missing-binding-step",
        objective: "submit application",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["submitted"],
        risk: "irreversible",
        capabilityNames: ["final_submit"]
      }],
      assumptions: [],
      approvalPoints: [{ id: "approval:missing-binding-step", kind: "final_submit", stepId: "missing-binding-step", required: true }],
      estimatedCost: { steps: 1, toolCalls: 1, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: createSupervisor({ now: () => "2026-09-03T00:00:00.000Z" }),
      planValidator: createPlanValidator({ capabilityNames: ["final_submit"] }),
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "missing-binding-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "missing-binding-run" } });

    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("plan_invalid");
  });

  it("retries a retryable specialist failure until maxAttempts", async () => {
    const plan = PlanStateSchema.parse({
      planId: "plan-retry",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "retryable-step",
        objective: "prepare application",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 2,
        acceptanceCriteria: ["prepared"],
        risk: "low"
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    let calls = 0;
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: createSupervisor({ now: () => "2026-09-03T00:00:00.000Z" }),
      planValidator: createPlanValidator(),
      agents: { application_agent: {
        execute: async ({ step }) => {
          calls += 1;
          return calls === 1
            ? { status: "failed" as const, errorCode: "temporary_failure", retryable: true }
            : { status: "completed" as const, evidenceRefs: ["evidence-retry"], satisfiedCriteria: step.acceptanceCriteria };
        }
      } },
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "retry-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "retry-run" } });

    expect(result.status).toBe("completed");
    expect(calls).toBe(2);
    expect(result.budget.retries).toBe(1);
    expect(result.plan?.steps[0]?.attempt).toBe(2);
  });

  it("compares every runtime budget metric before dispatch", async () => {
    const metrics = [
      ["steps", "maxSteps"],
      ["toolCalls", "maxToolCalls"],
      ["replans", "maxReplans"],
      ["retries", "maxRetries"],
      ["tokens", "maxTokens"],
      ["elapsedMs", "maxDurationMs"]
    ] as const;
    for (const [metric, limitName] of metrics) {
      const plan = PlanStateSchema.parse({
        planId: `plan-budget-${metric}`,
        intentId: intentForApplication.intentId,
        revision: 1,
        steps: [],
        assumptions: [],
        approvalPoints: [],
        estimatedCost: { steps: 0, toolCalls: 0, tokens: 0, durationMs: 0 },
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z"
      });
      const graph = createSupervisorGraph({
        planner: { create: async () => plan },
        supervisor: { decide: async () => ({ type: "finish" as const, outcome: "completed" as const, summary: "done" }) },
        planValidator: createPlanValidator(),
        budgetLimits: { [limitName]: 1 },
        now: () => "2026-09-03T00:00:02.000Z",
        checkpointer: new MemorySaver()
      });
      const budget = {
        steps: 0,
        toolCalls: 0,
        replans: 0,
        retries: 0,
        tokens: 0,
        elapsedMs: 0,
        [metric]: 2
      };
      const result = await graph.invoke({
        runId: `budget-${metric}`,
        intent: intentForApplication,
        evidenceRefs: ["evidence-1"],
        startedAt: "2026-09-03T00:00:00.000Z",
        budget,
        iteration: 0
      }, { configurable: { thread_id: `budget-${metric}` } });
      expect(result.status, metric).toBe("blocked");
      expect(result.error?.code, metric).toBe("budget_exceeded");
    }
  });

  it("does not accept an attempt token supplied by the plan input", async () => {
    const plan = PlanStateSchema.parse({
      planId: "plan-forged-attempt",
      intentId: intentForApplication.intentId,
      revision: 1,
      steps: [{
        id: "forged-step",
        objective: "prepare application",
        owner: "application",
        status: "pending",
        dependsOn: [],
        inputRefs: [intentForApplication.intentId],
        outputRefs: [],
        attempt: 0,
        attemptToken: "attempt:attacker",
        maxAttempts: 1,
        acceptanceCriteria: ["prepared"],
        risk: "low"
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const execute = vi.fn(async () => ({ status: "completed" as const }));
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: createSupervisor({ now: () => "2026-09-03T00:00:00.000Z" }),
      planValidator: createPlanValidator(),
      agents: { application_agent: { execute } },
      checkpointer: new MemorySaver()
    });
    const result = await graph.invoke({
      runId: "forged-attempt-run",
      intent: intentForApplication,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "forged-attempt-run" } });
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("attempt_token_invalid");
    expect(execute).not.toHaveBeenCalled();
  });
});
