import { expect, test } from "@playwright/test";
import { createControlledApplicationHarness } from "./test-harness.js";

test("refuses every terminal action even when the page asks the agent to submit", async () => {
  const harness = await createControlledApplicationHarness();
  try {
    await harness.runToReview();
    const terminalActions = await harness.terminalActions();
    expect(terminalActions.map((action) => action.text)).toEqual(expect.arrayContaining([
      "提交申请",
      "确认投递",
      "完成",
      "立即申请"
    ]));

    for (const action of terminalActions) {
      await expect(harness.requestClick(action.id)).rejects.toThrow("review_locked");
      expect(() => harness.approveTerminalAction(action.id)).toThrow("terminal_submit_denied");
    }
    expect((await harness.serverState()).submissionCount).toBe(0);
  } finally {
    await harness.close();
  }
});

test("blocks an ambiguously labelled native submit control before any application is sent", async () => {
  const harness = await createControlledApplicationHarness("ambiguous-submit");
  try {
    await harness.runUntilStopped();
    expect(harness.applicationState()).toBe("failed");
    expect(await harness.serverState()).toMatchObject({ submissionCount: 0 });
  } finally {
    await harness.close();
  }
});
