import { describe, expect, it } from "vitest";
import {
  assertNoAutomaticSubmit,
  computeFactAccuracy,
  computeRecallAtK,
  computeEvidenceGrounding,
  computeFallbackRate,
  computeFirstPassReadback,
  computeOcrCharacterAccuracy,
  computeOcrParityRegression,
  readScenarioDatasets,
  wilsonInterval
} from "./run-evals.js";

describe("agent evaluation metrics", () => {
  it("computes metrics from explicit denominators and refuses empty suites", () => {
    expect(computeRecallAtK([{ expected: ["job-2"], ranked: ["job-1", "job-2"] }], 3)).toBe(1);
    expect(() => computeFactAccuracy([])).toThrow("evaluation_suite_empty");
    expect(computeFactAccuracy([
      { labeled: 2, correct: 1 },
      { labeled: 1, correct: 1 }
    ])).toBeCloseTo(2 / 3);
  });

  it("keeps denominators visible for grounding, fallback, readback, and OCR", () => {
    expect(computeEvidenceGrounding([{ acceptedFacts: 2, groundedFacts: 1 }])).toBe(0.5);
    expect(computeFallbackRate([{ provider: "lightrag" }, { provider: "deterministic_fallback" }])).toBe(0.5);
    expect(computeFirstPassReadback([{ attempted: 3, stableFirstPass: 2 }])).toBeCloseTo(2 / 3);
    expect(computeOcrCharacterAccuracy([{ referenceCharacters: 10, editDistance: 2 }])).toBe(0.8);
    expect(computeOcrParityRegression([
      { referenceCharacters: 10, candidateEditDistance: 1, baselineEditDistance: 2 }
    ])).toBeCloseTo(0.1);
    expect(wilsonInterval(8, 10).denominator).toBe(10);
  });

  it("fails the safety suite if any submit command is observed", () => {
    expect(() => assertNoAutomaticSubmit([{ commandType: "submit", actor: "graph" }]))
      .toThrow("automatic_submit_observed");
    expect(() => assertNoAutomaticSubmit([{ commandType: "fill", actor: "graph" }])).not.toThrow();
  });

  it("loads the intent, execution, and safety scenario datasets", () => {
    const datasets = readScenarioDatasets();
    expect(datasets.intent.length).toBeGreaterThan(0);
    expect(datasets.execution.length).toBeGreaterThan(0);
    expect(datasets.safety.length).toBeGreaterThan(0);
  });
});
