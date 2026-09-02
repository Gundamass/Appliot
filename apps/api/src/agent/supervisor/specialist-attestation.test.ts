import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { CanonicalIntentSchema, PlanStateSchema } from "@resume/contracts";
import { createCallerAttestationAuthority } from "../policy/caller-attestation.js";
import { createPlanValidator } from "./plan-validator.js";
import { createSupervisorGraph } from "./supervisor-graph.js";

describe("Supervisor specialist caller attestation", () => {
  it("passes only the specialist-scoped token to a dispatched agent", async () => {
    const authority = createCallerAttestationAuthority({ signingKey: Buffer.alloc(32, 33) });
    const token = authority.issuer.issue("specialist_agent");
    const intent = CanonicalIntentSchema.parse({
      intentId: "intent-specialist-attestation",
      schemaVersion: "1.0.0",
      revision: 1,
      rawInputRef: "message-specialist-attestation",
      primaryGoal: "analyze_resume",
      subGoals: ["analyze_resume"],
      entities: {},
      constraints: [],
      preferences: [],
      successCriteria: [{ id: "complete", description: "analysis complete", required: true }],
      riskProfile: { level: "low", requiresHumanApproval: false, reasons: [] },
      confidence: 1,
      ambiguities: [],
      missingInformation: [],
      autonomyLevel: "prepare",
      evidenceRefs: [],
      createdAt: "2026-09-03T00:00:00.000Z"
    });
    const plan = PlanStateSchema.parse({
      planId: "plan-specialist-attestation",
      intentId: intent.intentId,
      revision: 1,
      steps: [{
        id: "specialist-step",
        objective: "analyze_resume",
        owner: "resume",
        status: "pending",
        dependsOn: [],
        inputRefs: [intent.intentId],
        outputRefs: [],
        attempt: 0,
        maxAttempts: 1,
        acceptanceCriteria: ["analysis complete"],
        risk: "low"
      }],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1_000 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    let received: unknown;
    const graph = createSupervisorGraph({
      planner: { create: async () => plan },
      supervisor: {
        decide: async ({ readyStep }) => ({
          type: "dispatch_agent" as const,
          agent: "resume_agent",
          input: { stepId: readyStep!.id },
          reason: "dispatch resume specialist"
        })
      },
      planValidator: createPlanValidator(),
      specialistCallerAttestation: token,
      agents: {
        resume_agent: {
          execute: async (input) => {
            received = input.callerAttestation;
            return { status: "completed" as const };
          }
        }
      },
      checkpointer: new MemorySaver()
    });

    const result = await graph.invoke({
      runId: "specialist-attestation-run",
      intent,
      evidenceRefs: ["evidence-1"],
      iteration: 0
    }, { configurable: { thread_id: "specialist-attestation-run" } });

    expect(result.status).toBe("completed");
    expect(received).toBe(token);
    expect(authority.verifier.verify(received)).toMatchObject({ valid: true, caller: "specialist_agent" });
  });
});
