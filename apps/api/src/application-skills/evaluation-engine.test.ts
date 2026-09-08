import { describe, expect, it } from "vitest";
import type { SkillEvaluation, SkillExecutionRecord } from "@resume/contracts";
import {
  SKILL_EVALUATOR_VERSION,
  aggregateEvaluations,
  compareEvaluation,
  evaluateExecution,
  type EvaluationComparable
} from "./evaluation-engine.js";

describe("fixed Skill evaluation engine", () => {
  it("derives an auditable evaluation from readback, required-field, audit, and runtime facts", () => {
    const report = evaluateExecution({
      record: executionFixture({
        fieldOutcomes: [
          { semantic: "basics.name", outcome: "verified" },
          { semantic: "basics.email", outcome: "failed", errorClass: "readback_mismatch" },
          { semantic: "basics.phone", outcome: "missing", errorClass: "field_missing" }
        ],
        counts: { observed: 3, planned: 3, verified: 1, auditMismatches: 1, userCorrections: 2 },
        auditMismatchClasses: ["unexpected_value"],
        retries: 2,
        recoveries: 1,
        durationMs: 1_200,
        terminalResult: "failed"
      }),
      requiredSemantics: ["basics.name", "basics.email", "basics.phone"],
      auditCompleted: true,
      source: "online",
      evaluatedAt: "2026-09-07T09:00:00.000Z"
    });

    expect(SKILL_EVALUATOR_VERSION).toBe("1.0.0");
    expect(report.evaluation).toMatchObject({
      evaluatorVersion: "1.0.0",
      source: "online",
      safetyViolations: 0,
      incorrectWrites: 2,
      fieldAccuracy: 0.5,
      requiredCompletion: 1 / 3,
      userCorrections: 2,
      retries: 2,
      recoveries: 1,
      durationMs: 1_200,
      decision: "fail"
    });
    expect(report.evaluation.evaluationId).toMatch(/^skill-evaluation-[a-f0-9]{32}$/u);
    expect(report.vector).toEqual({
      safetyViolations: 0,
      incorrectWrites: 2,
      fieldAccuracy: 0.5,
      requiredCompletion: 1 / 3,
      userCorrections: 2,
      retries: 2,
      recoveries: 1,
      durationMs: 1_200
    });
    expect(report.facts).toMatchObject({
      auditCompleted: true,
      terminalResult: "failed",
      requiredSemantics: ["basics.name", "basics.email", "basics.phone"],
      auditMismatchClasses: ["unexpected_value"]
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.facts.fieldOutcomes)).toBe(true);
  });

  it("treats an incomplete audit as a safety violation and fails closed", () => {
    const report = evaluateExecution({
      record: executionFixture(),
      requiredSemantics: ["basics.name"],
      auditCompleted: false,
      source: "replay",
      evaluatedAt: "2026-09-07T09:00:00.000Z"
    });

    expect(report.evaluation.safetyViolations).toBe(1);
    expect(report.evaluation.decision).toBe("fail");
    expect(report.facts.safetyEvents).toContain("audit_incomplete");
  });

  it("handles an empty required-field set without NaN or a false failure", () => {
    const report = evaluateExecution({
      record: executionFixture({
        fieldOutcomes: [],
        counts: { observed: 0, planned: 0, verified: 0, auditMismatches: 0, userCorrections: 0 }
      }),
      requiredSemantics: [],
      auditCompleted: true,
      source: "synthetic",
      evaluatedAt: "2026-09-07T09:00:00.000Z"
    });

    expect(report.evaluation.fieldAccuracy).toBe(1);
    expect(report.evaluation.requiredCompletion).toBe(1);
    expect(report.evaluation.decision).toBe("pass");
  });

  it("retains timeout evidence and never marks a timed-out execution as passing", () => {
    const report = evaluateExecution({
      record: executionFixture({
        firstError: { stage: "recovery", errorClass: "timeout" },
        terminalResult: "failed"
      }),
      requiredSemantics: ["basics.name"],
      auditCompleted: true,
      source: "online",
      evaluatedAt: "2026-09-07T09:00:00.000Z"
    });

    expect(report.evaluation.fieldAccuracy).toBe(1);
    expect(report.evaluation.requiredCompletion).toBe(1);
    expect(report.evaluation.decision).toBe("fail");
    expect(report.facts.firstError).toEqual({ stage: "recovery", errorClass: "timeout" });
  });

  it("uses the fixed lexicographic precedence and duration only as the final tie-breaker", () => {
    expect(compareEvaluation(
      vector({ safetyViolations: 1, fieldAccuracy: 1, requiredCompletion: 1, durationMs: 10 }),
      vector({ incorrectWrites: 1, fieldAccuracy: 0, requiredCompletion: 0, userCorrections: 9, retries: 9, durationMs: 99_000 })
    )).toBe("right");

    expect(compareEvaluation(
      vector({ incorrectWrites: 1, fieldAccuracy: 1 }),
      vector({ incorrectWrites: 0, fieldAccuracy: 0 })
    )).toBe("right");
    expect(compareEvaluation(
      vector({ fieldAccuracy: 0.9, requiredCompletion: 1 }),
      vector({ fieldAccuracy: 1, requiredCompletion: 0 })
    )).toBe("right");
    expect(compareEvaluation(
      vector({ requiredCompletion: 0.9, userCorrections: 0 }),
      vector({ requiredCompletion: 1, userCorrections: 99 })
    )).toBe("right");
    expect(compareEvaluation(
      vector({ userCorrections: 1, retries: 0, recoveries: 0 }),
      vector({ userCorrections: 0, retries: 9, recoveries: 9 })
    )).toBe("right");
    expect(compareEvaluation(
      vector({ retries: 1, recoveries: 1, durationMs: 1 }),
      vector({ retries: 1, recoveries: 0, durationMs: 99_000 })
    )).toBe("right");
    expect(compareEvaluation(
      vector({ durationMs: 101 }),
      vector({ durationMs: 100 })
    )).toBe("right");
    expect(compareEvaluation(vector(), vector())).toBe("equal");
  });

  it("aggregates unique execution records, ignores exact duplicates, and rejects conflicting duplicates", () => {
    const first = evaluationFixture("evaluation-1", "execution-1", {
      fieldAccuracy: 1,
      requiredCompletion: 1,
      durationMs: 100
    });
    const second = evaluationFixture("evaluation-2", "execution-2", {
      safetyViolations: 1,
      incorrectWrites: 2,
      fieldAccuracy: 0.5,
      requiredCompletion: 0,
      userCorrections: 2,
      retries: 1,
      recoveries: 1,
      durationMs: 300,
      decision: "fail"
    });

    expect(aggregateEvaluations([first, second, first])).toEqual({
      evaluatorVersion: "1.0.0",
      sampleCount: 2,
      evaluationIds: ["evaluation-1", "evaluation-2"],
      executionRecordIds: ["execution-1", "execution-2"],
      safetyViolations: 1,
      incorrectWrites: 2,
      fieldAccuracy: 0.75,
      requiredCompletion: 0.5,
      userCorrections: 2,
      retries: 1,
      recoveries: 1,
      durationMs: 200,
      totalDurationMs: 400
    });
    expect(() => aggregateEvaluations([
      first,
      { ...first, evaluationId: "evaluation-conflict", durationMs: 101 }
    ])).toThrow("skill_evaluation_duplicate_conflict");
    expect(() => aggregateEvaluations([])).toThrow("skill_evaluation_aggregate_empty");
  });

  it("is deterministic, antisymmetric, and transitive across seeded randomized vectors", () => {
    const random = mulberry32(0x5eed_1400);
    const samples = Array.from({ length: 200 }, () => vector({
      safetyViolations: Math.floor(random() * 3),
      incorrectWrites: Math.floor(random() * 4),
      fieldAccuracy: Math.floor(random() * 11) / 10,
      requiredCompletion: Math.floor(random() * 11) / 10,
      userCorrections: Math.floor(random() * 5),
      retries: Math.floor(random() * 4),
      recoveries: Math.floor(random() * 4),
      durationMs: Math.floor(random() * 10_000)
    }));

    for (let index = 0; index < samples.length - 2; index += 1) {
      const left = samples[index]!;
      const middle = samples[index + 1]!;
      const right = samples[index + 2]!;
      expect(reverse(compareEvaluation(left, middle))).toBe(compareEvaluation(middle, left));
      if (compareEvaluation(left, middle) === "left" && compareEvaluation(middle, right) === "left") {
        expect(compareEvaluation(left, right)).toBe("left");
      }
    }

    const sortedOnce = [...samples].sort(sortBestFirst);
    const sortedAgain = [...samples].reverse().sort(sortBestFirst);
    expect(sortedAgain).toEqual(sortedOnce);
  });
});

function executionFixture(overrides: Partial<SkillExecutionRecord> = {}): SkillExecutionRecord {
  return {
    recordId: "skill-record-fixture",
    taskId: "task-fixture",
    attemptId: "attempt-fixture",
    binding: {
      skillId: "baidu-application",
      version: "1.0.0",
      site: "baidu",
      pageFingerprintHash: "a".repeat(64),
      allocationId: "allocation-fixture"
    },
    pageVariantId: "application-form",
    allocation: "champion",
    fieldOutcomes: [{ semantic: "basics.name", outcome: "verified" }],
    counts: { observed: 1, planned: 1, verified: 1, auditMismatches: 0, userCorrections: 0 },
    auditMismatchClasses: [],
    retries: 0,
    recoveries: 0,
    durationMs: 500,
    terminalResult: "completed_pre_submit",
    startedAt: "2026-09-07T08:00:00.000Z",
    completedAt: "2026-09-07T08:00:00.500Z",
    ...overrides
  };
}

function evaluationFixture(
  evaluationId: string,
  executionRecordId: string,
  overrides: Partial<SkillEvaluation> = {}
): SkillEvaluation {
  return {
    evaluationId,
    executionRecordId,
    evaluatorVersion: "1.0.0",
    source: "replay",
    safetyViolations: 0,
    incorrectWrites: 0,
    fieldAccuracy: 1,
    requiredCompletion: 1,
    userCorrections: 0,
    retries: 0,
    recoveries: 0,
    durationMs: 100,
    decision: "pass",
    evaluatedAt: "2026-09-07T09:00:00.000Z",
    ...overrides
  };
}

function vector(overrides: Partial<EvaluationComparable> = {}): EvaluationComparable {
  return {
    safetyViolations: 0,
    incorrectWrites: 0,
    fieldAccuracy: 1,
    requiredCompletion: 1,
    userCorrections: 0,
    retries: 0,
    recoveries: 0,
    durationMs: 100,
    ...overrides
  };
}

function reverse(result: "left" | "right" | "equal"): "left" | "right" | "equal" {
  return result === "left" ? "right" : result === "right" ? "left" : "equal";
}

function sortBestFirst(left: EvaluationComparable, right: EvaluationComparable): number {
  const result = compareEvaluation(left, right);
  return result === "left" ? -1 : result === "right" ? 1 : 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}
