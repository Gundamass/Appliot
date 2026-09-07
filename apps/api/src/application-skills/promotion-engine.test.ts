import { describe, expect, it } from "vitest";
import type { ApplicationSkillVersion, SkillEvaluation, SkillExecutionRecord } from "@resume/contracts";
import {
  PromotionEngine,
  type PromotionEngineRegistry,
  type PromotionEvaluationSample
} from "./promotion-engine.js";
import type { StratifiedBootstrapResult } from "./statistics.js";

describe("PromotionEngine", () => {
  it.each([
    ["safety violation", { safetyViolations: 1 }, 0],
    ["incorrect write", { incorrectWrites: 1 }, 0],
    ["new full-page mismatch", {}, 1]
  ])("rolls back immediately after recording a %s", async (_label, evaluationPatch, mismatches) => {
    const registry = new MemoryPromotionRegistry();
    const engine = new PromotionEngine({ registry });
    const result = await engine.recordAndDecide(sample(1, evaluationPatch, mismatches));
    expect(result).toEqual({ kind: "rolled_back", evaluationId: "evaluation-1" });
    expect(registry.events.slice(0, 2)).toEqual(["append:evaluation-1", "cas:challenger:quarantined"]);
    expect(registry.status).toBe("quarantined");
    expect(registry.allocation).toMatchObject({ championPercent: 100, challengerPercent: 0 });
  });

  it("promotes only after the statistical comparison is positive", async () => {
    const registry = new MemoryPromotionRegistry();
    registry.seed(9);
    const engine = new PromotionEngine({ registry, compare: () => comparison("promote", 10) });
    expect(await engine.recordAndDecide(sample(10))).toEqual({ kind: "promoted", evaluationId: "evaluation-10" });
    expect(registry.status).toBe("champion");
    expect(registry.allocation).toMatchObject({ championVersion: "1.1.0", championPercent: 100, challengerPercent: 0 });
  });

  it("continues below fifty inconclusive runs and retires at fifty", async () => {
    const below = new MemoryPromotionRegistry();
    below.seed(48);
    expect(await new PromotionEngine({ registry: below, compare: () => comparison("continue", 49) })
      .recordAndDecide(sample(49))).toEqual({ kind: "continue", evaluationId: "evaluation-49" });
    expect(below.status).toBe("challenger");

    const stop = new MemoryPromotionRegistry();
    stop.seed(49);
    expect(await new PromotionEngine({ registry: stop, compare: () => comparison("stop-inconclusive", 50) })
      .recordAndDecide(sample(50))).toEqual({ kind: "stopped_inconclusive", evaluationId: "evaluation-50" });
    expect(stop.status).toBe("retired");
    expect(stop.allocation).toMatchObject({ championPercent: 100, challengerPercent: 0 });
  });

  it("starts a fresh statistical window at activation and evaluator-version changes", async () => {
    const registry = new MemoryPromotionRegistry();
    const historical = sample(1);
    registry.samples.push({
      ...historical,
      evaluation: {
        ...historical.evaluation,
        evaluatorVersion: "0.9.0",
        evaluatedAt: "2026-09-07T10:00:00.000Z"
      }
    });
    const engine = new PromotionEngine({
      registry,
      compare(input) {
        expect(input.evaluatorVersion).toBe("1.0.0");
        expect(input.challenger.map(({ executionId }) => executionId)).toEqual(["record-2"]);
        return comparison("insufficient", 1);
      }
    });

    expect(await engine.recordAndDecide(sample(2))).toEqual({
      kind: "continue",
      evaluationId: "evaluation-2"
    });
  });

  it("is idempotent for duplicate delivery and late evidence after rollback", async () => {
    const registry = new MemoryPromotionRegistry();
    const engine = new PromotionEngine({ registry });
    const unsafe = sample(1, { safetyViolations: 1 });
    expect((await engine.recordAndDecide(unsafe)).kind).toBe("rolled_back");
    expect((await engine.recordAndDecide(unsafe)).kind).toBe("rolled_back");
    expect((await engine.recordAndDecide(sample(2))).kind).toBe("rolled_back");
    expect(registry.samples).toHaveLength(2);
    expect(registry.events.filter((event) => event.startsWith("cas:"))).toHaveLength(1);
  });

  it("allows only one winner when two workers race to promote", async () => {
    const registry = new MemoryPromotionRegistry();
    registry.seed(9);
    const left = new PromotionEngine({ registry, compare: () => comparison("promote", 11) });
    const right = new PromotionEngine({ registry, compare: () => comparison("promote", 11) });
    const results = await Promise.all([left.recordAndDecide(sample(10)), right.recordAndDecide(sample(11))]);
    expect(results.map(({ kind }) => kind)).toEqual(["promoted", "promoted"]);
    expect(registry.events.filter((event) => event === "cas:challenger:champion")).toHaveLength(1);
  });
});

function comparison(decision: StratifiedBootstrapResult["decision"], count: number): StratifiedBootstrapResult {
  return { championCount: count, challengerCount: count, eligibleChallengerCount: count, stratumCount: 1,
    firstDifferingDimension: "fieldAccuracy", observedDelta: 0.1, confidenceInterval95: [0.05, 0.15], decision };
}

function sample(index: number, patch: Partial<SkillEvaluation> = {}, newAuditMismatches = 0): PromotionEvaluationSample {
  const record = {
    recordId: `record-${index}`,
    taskId: `task-${index}`,
    attemptId: `attempt-${index}`,
    binding: { skillId: "baidu-application", version: "1.1.0", site: "baidu", pageFingerprintHash: "a".repeat(64), allocationId: "allocation-1" },
    pageVariantId: "application-form",
    allocation: "challenger",
    fieldOutcomes: [], counts: { observed: 1, planned: 1, verified: 1, auditMismatches: newAuditMismatches, userCorrections: 0 },
    auditMismatchClasses: newAuditMismatches ? ["required_empty"] : [], retries: 0, recoveries: 0, durationMs: 10,
    terminalResult: "completed_pre_submit", startedAt: "2026-09-07T12:00:00.000Z", completedAt: "2026-09-07T12:00:01.000Z"
  } as SkillExecutionRecord;
  return { record, scenarioClass: "stable", requiredFieldCount: 1, newAuditMismatches, evaluation: {
    evaluationId: `evaluation-${index}`, executionRecordId: record.recordId, evaluatorVersion: "1.0.0", source: "online",
    safetyViolations: 0, incorrectWrites: 0, fieldAccuracy: 1, requiredCompletion: 1, userCorrections: 0,
    retries: 0, recoveries: 0, durationMs: 10, decision: "pass", evaluatedAt: "2026-09-07T12:00:02.000Z", ...patch
  } };
}

class MemoryPromotionRegistry implements PromotionEngineRegistry {
  status: ApplicationSkillVersion["status"] = "challenger";
  samples: PromotionEvaluationSample[] = [];
  events: string[] = [];
  allocation = { allocationId: "allocation-1", skillId: "baidu-application", site: "baidu" as const,
    pageFingerprintHash: "a".repeat(64), championVersion: "1.0.0", challengerVersion: "1.1.0",
    championPercent: 90, challengerPercent: 10, updatedAt: "2026-09-07T11:00:00.000Z" };
  seed(count: number) { for (let index = 1; index <= count; index += 1) this.samples.push(sample(index)); }
  appendPromotionEvaluation(value: PromotionEvaluationSample) {
    this.events.push(`append:${value.evaluation.evaluationId}`);
    if (this.samples.some(({ evaluation }) => evaluation.evaluationId === value.evaluation.evaluationId)) return false;
    this.samples.push(value); return true;
  }
  listPromotionEvaluations() { return [...this.samples]; }
  getPageAllocation() { return { ...this.allocation }; }
  getVersion() { return { status: this.status } as ApplicationSkillVersion; }
  compareAndSetStatus(_key: unknown, expected: ApplicationSkillVersion["status"], next: ApplicationSkillVersion["status"]) {
    if (this.status !== expected) return false;
    this.events.push(`cas:${expected}:${next}`); this.status = next;
    if (next === "quarantined") this.allocation = { ...this.allocation, championPercent: 100, challengerPercent: 0, challengerVersion: undefined as never };
    if (next === "champion") this.allocation = { ...this.allocation, championVersion: "1.1.0", championPercent: 100, challengerPercent: 0, challengerVersion: undefined as never };
    return true;
  }
  retireChallenger() { if (this.status !== "challenger") return false; this.status = "retired";
    this.allocation = { ...this.allocation, championPercent: 100, challengerPercent: 0, challengerVersion: undefined as never }; return true; }
}
