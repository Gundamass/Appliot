import { describe, expect, it, vi } from "vitest";
import { Command } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { CanonicalIntentSchema, PlanStateSchema } from "@resume/contracts";
import { z } from "zod";
import { createCapabilityCatalog } from "../capabilities/catalog.js";
import { defineCapability } from "../capabilities/descriptor.js";
import { createApprovalSystem } from "../policy/approval-gate.js";
import { createPolicyEngine } from "../policy/policy-engine.js";
import { createSupervisorGraph } from "./supervisor-graph.js";
import { createPlanValidator } from "./plan-validator.js";
import { createPlanner } from "./planner.js";
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
      agents: { application_agent: { execute: async () => ({ status: "completed" as const }) } },
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
        application_agent: { execute: async () => ({ status: "completed" as const }) }
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

  it("resumes an approved high-risk agent step and preserves the same plan", async () => {
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
    const execute = vi.fn(async () => ({ status: "completed" as const, outputRef: "output:prepare" }));
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
      resume: { interruptId: first.pendingInterrupt!.interruptId, action: "approve", values: {} }
    }), config);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(second.plan?.steps[0]?.status).toBe("completed");
    expect(second.status).toBe("completed");
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
    const policy = createPolicyEngine({
      catalog,
      approvalGate: createApprovalSystem({
        signingKey: Buffer.alloc(32, 5),
        verifyHumanPrincipal: () => ({ subject: "user-1" })
      }).gate
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
});
