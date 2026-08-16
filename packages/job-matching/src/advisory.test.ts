import type { JobRequirement } from "@resume/contracts";
import { describe, expect, it } from "vitest";
import { UNKNOWN_ADVISORY, validateAdvisory } from "./advisory.js";

const requirement: JobRequirement = {
  id: "req-1",
  category: "skill",
  normalizedValue: "java",
  required: true,
  sourceEvidence: "熟悉 Java"
};

describe("validateAdvisory", () => {
  it("accepts a high-confidence advisory limited to retrieved evidence", () => {
    expect(validateAdvisory(requirement, ["e1", "e2", "e3"], {
      outcome: "satisfied",
      confidence: 0.95,
      evidenceIds: ["e2"]
    })).toEqual({ outcome: "satisfied", confidence: 0.95, evidenceIds: ["e2"] });
  });

  it("rejects evidence outside the supplied Top-3", () => {
    expect(validateAdvisory(requirement, ["e1", "e2"], {
      outcome: "satisfied",
      confidence: 0.95,
      evidenceIds: ["e9"]
    })).toEqual(UNKNOWN_ADVISORY);
  });

  it("degrades low-confidence, malformed, and conflict responses to unknown", () => {
    expect(validateAdvisory(requirement, ["e1"], {
      outcome: "satisfied",
      confidence: 0.89,
      evidenceIds: ["e1"]
    })).toEqual(UNKNOWN_ADVISORY);
    expect(validateAdvisory(requirement, ["e1"], {
      outcome: "conflict",
      confidence: 0.99,
      evidenceIds: ["e1"]
    })).toEqual(UNKNOWN_ADVISORY);
    expect(validateAdvisory(requirement, ["e1"], {
      outcome: "satisfied",
      confidence: 0.99,
      evidenceIds: ["e1"],
      explanation: "unexpected"
    })).toEqual(UNKNOWN_ADVISORY);
    expect(validateAdvisory(requirement, ["e1"], null)).toEqual(UNKNOWN_ADVISORY);
  });

  it("uses no more than the first three allowed evidence IDs", () => {
    expect(validateAdvisory(requirement, ["e1", "e2", "e3", "e4"], {
      outcome: "satisfied",
      confidence: 0.95,
      evidenceIds: ["e4"]
    })).toEqual(UNKNOWN_ADVISORY);
  });
});
