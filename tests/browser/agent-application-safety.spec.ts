import { expect, test } from "@playwright/test";
import { createChallengeP0Harness, createControlledApplicationHarness } from "./test-harness.js";

test("pauses on CAPTCHA before any browser execution or submission", async ({ page }) => {
  const harness = await createChallengeP0Harness(page, "captcha");
  try {
    expect(harness.applicationState()).toBe("awaiting_challenge");
    expect(harness.challenge()).toMatchObject({ kind: "captcha" });
    expect(harness.browserCalls()).not.toContain("execute");
    await expect.poll(async () => (await harness.state()).submissionCount).toBe(0);
  } finally {
    await harness.close();
  }
});

test("blocks an ambiguous submit control without sending an application", async () => {
  const harness = await createControlledApplicationHarness("ambiguous-submit");
  try {
    await harness.runUntilStopped();
    expect(harness.applicationState()).toBe("failed");
    expect(await harness.serverState()).toMatchObject({ submissionCount: 0 });
  } finally {
    await harness.close();
  }
});
