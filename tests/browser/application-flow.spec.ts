import { expect, test } from "@playwright/test";
import { createControlledApplicationHarness } from "./test-harness.js";

test("fills two pages automatically and stops at the review lock", async () => {
  const harness = await createControlledApplicationHarness();
  try {
    await harness.runToReview();

    expect(harness.applicationState()).toBe("review_locked");
    expect(await harness.serverState()).toMatchObject({
      submissionCount: 0,
      draft: {
        email: "me@example.com",
        city: "hangzhou",
        selfEvaluation: "具备扎实的 Java 后端开发能力"
      }
    });
  } finally {
    await harness.close();
  }
});
