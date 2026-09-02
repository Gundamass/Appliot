import { describe, expect, it } from "vitest";
import { createRuntimeCheckpointStore } from "./checkpoint-store.js";

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    version: "2.0.0",
    runId: "run-1",
    executionEpoch: 0,
    status: "interrupted" as const,
    currentStepId: "submit",
    intentRef: "intent:1",
    planRef: "plan:1",
    memoryRefs: [],
    evidenceRefs: [],
    pendingInterrupt: {
      interruptId: "interrupt-1",
      reason: "final_submit" as const,
      summary: "需要人工确认",
      evidenceRefs: [],
      expiresAt: "2026-09-02T01:00:00.000Z"
    },
    budget: { steps: 1, toolCalls: 0, retries: 0, replans: 0, tokens: 0, elapsedMs: 10 },
    completedActionIds: [],
    stateHash: "a".repeat(64),
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides
  };
}

describe("RuntimeCheckpointStore", () => {
  it("stores only schema-approved bounded state and returns the newest checkpoint", async () => {
    const store = createRuntimeCheckpointStore();
    await store.save(checkpoint());
    await store.save({ ...checkpoint(), executionEpoch: 1, stateHash: "b".repeat(64) });

    const latest = await store.latest("run-1");
    expect(latest?.executionEpoch).toBe(1);
    expect(JSON.stringify(latest)).not.toContain("goal");
  });

  it("rejects sensitive fields before persistence, including nested payload data", async () => {
    const store = createRuntimeCheckpointStore();

    await expect(store.save({ ...checkpoint(), cookie: "session-cookie" })).rejects.toThrow(
      "runtime_checkpoint_unknown_field"
    );
    await expect(store.save({
      ...checkpoint(),
      pendingInterrupt: {
        ...checkpoint().pendingInterrupt,
        proposedAction: { password: "secret" }
      }
    })).rejects.toThrow("runtime_checkpoint_sensitive_field");
    expect(await store.latest("run-1")).toBeUndefined();
  });
});
