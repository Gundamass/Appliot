import { describe, expect, it } from "vitest";
import { AgentRunResultSchema, RuntimeCheckpointSchema } from "./agent-runtime.js";

describe("agent runtime contracts", () => {
  it("accepts an interrupted result with a human gate", () => {
    const result = AgentRunResultSchema.parse({
      runId: "run-1",
      status: "interrupted",
      intentId: "intent-1",
      planId: "plan-1",
      planRevision: 2,
      pendingInterrupt: {
        interruptId: "interrupt-1",
        reason: "final_submit",
        summary: "请确认最终提交内容",
        evidenceRefs: ["evidence-1"],
        proposedAction: { type: "final_submit" },
        expiresAt: "2026-09-02T01:00:00.000Z"
      },
      eventCursor: "cursor-1"
    });

    expect(result.pendingInterrupt?.reason).toBe("final_submit");
  });

  it("rejects sensitive or unbounded checkpoint fields", () => {
    expect(RuntimeCheckpointSchema.safeParse({
      version: "1.0.0",
      runId: "run-1",
      executionEpoch: 1,
      status: "running",
      memoryRefs: [],
      evidenceRefs: [],
      completedActionIds: [],
      budget: { steps: 0, toolCalls: 0, retries: 0, replans: 0, tokens: 0, elapsedMs: 0 },
      stateHash: "a".repeat(64),
      createdAt: "2026-09-02T00:00:00.000Z",
      cookie: "should-not-persist"
    }).success).toBe(false);
  });
});
