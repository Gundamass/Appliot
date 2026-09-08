import { describe, expect, it } from "vitest";
import type { SkillEvaluation } from "@resume/contracts";
import {
  stratifiedBootstrapComparison,
  type StratifiedEvaluationSample
} from "./statistics.js";

describe("stratifiedBootstrapComparison", () => {
  it("promotes a clear improvement with a stable 95 percent interval", () => {
    const result = compare(samples(12, "champion", { fieldAccuracy: 0.7 }), samples(12, "challenger", { fieldAccuracy: 1 }));
    expect(result).toMatchObject({
      championCount: 12,
      challengerCount: 12,
      eligibleChallengerCount: 12,
      firstDifferingDimension: "fieldAccuracy",
      observedDelta: 0.3,
      confidenceInterval95: [0.3, 0.3],
      decision: "promote"
    });
  });

  it("rolls back a clear regression and any hard safety failure", () => {
    expect(compare(
      samples(12, "champion", { requiredCompletion: 1 }),
      samples(12, "challenger", { requiredCompletion: 0.5 })
    )).toMatchObject({ firstDifferingDimension: "requiredCompletion", observedDelta: -0.5, decision: "rollback" });

    const unsafe = samples(12, "challenger", {});
    unsafe[7] = sample("challenger", 7, { safetyViolations: 1 });
    expect(compare(samples(12, "champion", {}), unsafe)).toMatchObject({
      firstDifferingDimension: "safetyViolations",
      decision: "rollback"
    });
  });

  it.each([
    [9, "insufficient"],
    [10, "continue"],
    [49, "continue"],
    [50, "stop-inconclusive"]
  ] as const)("returns the bounded inconclusive decision at %i Challenger runs", (count, decision) => {
    expect(compare(samples(count, "champion", {}), samples(count, "challenger", {}))).toMatchObject({
      eligibleChallengerCount: count,
      decision
    });
  });

  it("ignores unpaired sparse strata and uses fixed observed weights for an oversized stratum", () => {
    const champion = [
      ...samples(10, "champion", { fieldAccuracy: 0.5 }, "target"),
      ...samples(100, "champion", { fieldAccuracy: 1 }, "oversized"),
      ...samples(5, "champion", { fieldAccuracy: 0 }, "champion-only")
    ];
    const challenger = [
      ...samples(10, "challenger", { fieldAccuracy: 1 }, "target"),
      ...samples(100, "challenger", { fieldAccuracy: 1 }, "oversized"),
      ...samples(5, "challenger", { fieldAccuracy: 0 }, "challenger-only")
    ];
    const result = compare(champion, challenger);
    expect(result.eligibleChallengerCount).toBe(110);
    expect(result.stratumCount).toBe(2);
    expect(result.observedDelta).toBeCloseTo(0.5 * (20 / 220), 12);
    expect(result.decision).toBe("promote");
  });

  it("is byte-for-byte deterministic when inputs are reordered", () => {
    const champion = samples(60, "champion", { durationMs: 120 });
    const challenger = samples(60, "challenger", { durationMs: 100 });
    const first = compare(champion, challenger);
    const reordered = compare([...champion].reverse(), [...challenger].sort(() => -1));
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(first));
  });
});

function compare(champion: StratifiedEvaluationSample[], challenger: StratifiedEvaluationSample[]) {
  return stratifiedBootstrapComparison({
    allocationId: "allocation-statistics",
    evaluatorVersion: "1.0.0",
    iterations: 10_000,
    champion,
    challenger
  });
}

function samples(
  count: number,
  cohort: "champion" | "challenger",
  overrides: Partial<SkillEvaluation>,
  scenarioClass = "stable"
): StratifiedEvaluationSample[] {
  return Array.from({ length: count }, (_, index) => sample(cohort, index, overrides, scenarioClass));
}

function sample(
  cohort: "champion" | "challenger",
  index: number,
  overrides: Partial<SkillEvaluation>,
  scenarioClass = "stable"
): StratifiedEvaluationSample {
  const executionId = `${cohort}-${scenarioClass}-${index}`;
  return {
    executionId,
    site: "baidu",
    pageFingerprintHash: "a".repeat(64),
    scenarioClass,
    requiredFieldCount: 3,
    newAuditMismatches: 0,
    evaluation: {
      evaluationId: `evaluation-${executionId}`,
      executionRecordId: executionId,
      evaluatorVersion: "1.0.0",
      source: "online",
      safetyViolations: 0,
      incorrectWrites: 0,
      fieldAccuracy: 1,
      requiredCompletion: 1,
      userCorrections: 0,
      retries: 0,
      recoveries: 0,
      durationMs: 100,
      decision: "pass",
      evaluatedAt: "2026-09-07T12:00:00.000Z",
      ...overrides
    }
  };
}
