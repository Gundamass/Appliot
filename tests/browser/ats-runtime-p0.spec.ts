import { expect, test } from "@playwright/test";
import {
  createRuntimeP0Harness,
  type RuntimeP0Scenario,
  type RuntimeP0State
} from "./test-harness.js";

const staleScenarios: Array<{
  scenario: Extract<RuntimeP0Scenario, "insert-before" | "replace-same-index" | "reorder">;
  valueKey: "target" | "replacement";
}> = [
  { scenario: "insert-before", valueKey: "target" },
  { scenario: "replace-same-index", valueKey: "replacement" },
  { scenario: "reorder", valueKey: "target" }
];

for (const { scenario, valueKey } of staleScenarios) {
  test(`${scenario} rejects the observed node instead of rebinding by DOM position`, async ({ page }) => {
    const harness = await createRuntimeP0Harness(page, scenario);
    try {
      await harness.triggerMutation();
      await harness.apply("target", "must-not-be-written");

      expect(await harness.value(valueKey)).toBe("");
      expect(harness.lastError()).toBe("stale_node_ref");
      await expectNeverSubmitted(harness.state);
    } finally {
      await harness.close();
    }
  });
}

test("rollback after 500 ms fails the second local readback", async ({ page }) => {
  const harness = await createRuntimeP0Harness(page, "rollback-500ms");
  try {
    const result = await harness.apply("target", "temporary-value");

    expect(result.status).toBe("failed");
    expect(harness.lastError()).toBe("controlled_value_reverted");
    expect(await harness.value("target")).toBe("");
    await expectNeverSubmitted(harness.state);
  } finally {
    await harness.close();
  }
});

test("continuous relevant mutation reaches the bounded stability timeout", async ({ page }) => {
  const harness = await createRuntimeP0Harness(page, "continuous-mutation");
  try {
    const result = await harness.apply("target", "unstable-value");

    expect(result.status).toBe("failed");
    expect(harness.lastError()).toBe("control_unstable");
    await expectNeverSubmitted(harness.state);
  } finally {
    await harness.close();
  }
});

test("a stable control is written exactly once and reaches applied", async ({ page }) => {
  const harness = await createRuntimeP0Harness(page, "stable");
  try {
    const result = await harness.apply("target", "stable-value");

    expect(result.status).toBe("applied");
    await expect.poll(async () => (await harness.state()).runtime.writeCounts.target).toBe(1);
    await expectNeverSubmitted(harness.state);
  } finally {
    await harness.close();
  }
});

test("the eighth stable write triggers one full-page audit and never refills", async ({ page }) => {
  const harness = await createRuntimeP0Harness(page, "stable");
  try {
    const progress = await harness.runEightStableWritesToAudit();
    const state = await harness.state();

    expect(Object.values(state.runtime.writeCounts).filter((count) => count === 1)).toHaveLength(8);
    expect(state.runtime.auditCount).toBe(1);
    expect(progress).toMatchObject({
      status: "paused",
      lastResult: { operation: { status: "failed", errorCode: "READBACK_MISMATCH" } }
    });
    await expectNeverSubmitted(harness.state);
  } finally {
    await harness.close();
  }
});

async function expectNeverSubmitted(state: () => Promise<RuntimeP0State>): Promise<void> {
  await expect.poll(async () => (await state()).submissionCount).toBe(0);
}
