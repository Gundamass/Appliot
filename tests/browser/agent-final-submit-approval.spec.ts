import { expect, test } from "@playwright/test";
import { createControlledApplicationHarness } from "./test-harness.js";

test("requires human approval for terminal actions and never executes final_submit", async () => {
  const harness = await createControlledApplicationHarness();
  try {
    await harness.runToReview();
    const terminalActions = await harness.terminalActions();
    expect(terminalActions.length).toBeGreaterThan(0);

    for (const action of terminalActions) {
      await expect(harness.requestClick(action.id)).rejects.toThrow("review_locked");
      expect(() => harness.approveTerminalAction(action.id)).toThrow("terminal_submit_denied");
    }
    expect((await harness.serverState()).submissionCount).toBe(0);
  } finally {
    await harness.close();
  }
});
