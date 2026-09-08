import { describe, expect, it } from "vitest";
import { CanonicalIntentSchema, PlanStateSchema } from "@resume/contracts";
import { createCallerAttestationAuthority } from "../policy/caller-attestation.js";
import { createAgentRuntime } from "./agent-runtime.js";
import { createRuntimeCheckpointStore } from "./checkpoint-store.js";

describe("AgentRuntime caller attestation", () => {
  it("passes the runtime-scoped attestation to the executor", async () => {
    const authority = createCallerAttestationAuthority({ signingKey: Buffer.alloc(32, 32) });
    const token = authority.issuer.issue("runtime");
    const intent = CanonicalIntentSchema.parse({
      intentId: "intent-attestation",
      schemaVersion: "1.0.0",
      revision: 1,
      rawInputRef: "message-attestation",
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
      planId: "plan-attestation",
      intentId: intent.intentId,
      revision: 1,
      steps: [{
        id: "analysis-step",
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
    const runtime = createAgentRuntime({
      intentResolver: { resolve: async () => ({ type: "resolved" as const, intent }) },
      planner: { create: async () => plan },
      callerAttestation: token,
      executor: {
        execute: async (input) => {
          received = input.callerAttestation;
          return { status: "completed" as const };
        }
      },
      checkpointStore: createRuntimeCheckpointStore(),
      idFactory: () => "runtime-attestation-run",
      now: () => "2026-09-03T00:00:00.000Z"
    });

    const result = await runtime.start({ goal: "analyze resume", requestedBy: "user-1" });

    expect(result.status).toBe("completed");
    expect(received).toBe(token);
    expect(authority.verifier.verify(received)).toMatchObject({ valid: true, caller: "runtime" });
  });
});
