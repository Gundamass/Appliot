import { describe, expect, it } from "vitest";
import { createJobMatchActionKey } from "./job-match-action-key.js";

describe("createJobMatchActionKey", () => {
  it("keeps normal session ids readable and hashes overlong identities without collisions", () => {
    expect(createJobMatchActionKey("11111111-1111-4111-8111-111111111111", "confirm_filters", 0))
      .toBe("inline-job-match:11111111-1111-4111-8111-111111111111:confirm_filters:0");

    const longSession = "session-" + "a".repeat(240);
    const confirm = createJobMatchActionKey(longSession, "confirm_filters", 0);
    const adjust = createJobMatchActionKey(longSession, "adjust_filters", 0);
    const firstResult = createJobMatchActionKey(longSession, "select_result", 0, "result-" + "x".repeat(240));
    const secondResult = createJobMatchActionKey(longSession, "select_result", 0, "result-" + "y".repeat(240));

    expect(new Set([confirm, adjust, firstResult, secondResult]).size).toBe(4);
    expect([confirm, adjust, firstResult, secondResult].every((key) => key.length <= 128)).toBe(true);
  });
});
