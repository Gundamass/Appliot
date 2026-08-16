import { expect, test } from "@playwright/test";
import {
  createChallengeP0Harness,
  type ChallengeP0Scenario,
  type ChallengeP0State
} from "./test-harness.js";

const scenarios: Array<{
  scenario: ChallengeP0Scenario;
  kind: ChallengeP0State["challenge"]["kind"];
}> = [
  { scenario: "captcha", kind: "captcha" },
  { scenario: "access-denied", kind: "access_denied" },
  { scenario: "rate-limited", kind: "rate_limited" },
  { scenario: "device-verification", kind: "device_verification" },
  { scenario: "risk-control", kind: "risk_control" },
  { scenario: "interactive-iframe", kind: "unsupported_iframe" },
  { scenario: "open-shadow-input", kind: "unsupported_shadow_dom" },
  { scenario: "closed-shadow-host", kind: "unsupported_shadow_dom" }
];

for (const { scenario, kind } of scenarios) {
  test(`${scenario} enters a persistent Challenge pause without browser execution`, async ({ page }) => {
    const harness = await createChallengeP0Harness(page, scenario);
    try {
      expect(harness.applicationState()).toBe("awaiting_challenge");
      expect(harness.challenge()).toMatchObject({ kind });
      expect(harness.browserCalls()).not.toContain("execute");
      await expectNeverSubmitted(harness.state);
    } finally {
      await harness.close();
    }
  });
}

test("captcha remains paused after the page looks normal and resumes from a fresh observation only", async ({ page }) => {
  const harness = await createChallengeP0Harness(page, "captcha");
  try {
    const callsBeforeClear = harness.browserCalls();
    await harness.clearChallenge();
    await page.waitForTimeout(1_000);

    expect(harness.applicationState()).toBe("awaiting_challenge");
    expect(harness.browserCalls()).toEqual(callsBeforeClear);
    expect((await harness.state()).challenge.fillCount).toBe(0);

    await harness.resumeAfterChallenge();

    expect(harness.browserCalls().slice(callsBeforeClear.length)).toEqual(["invalidate", "observe"]);
    expect(harness.applicationState()).toBe("review_locked");
    await expectNeverSubmitted(harness.state);
  } finally {
    await harness.close();
  }
});

async function expectNeverSubmitted(state: () => Promise<ChallengeP0State>): Promise<void> {
  await expect.poll(async () => (await state()).submissionCount).toBe(0);
}
