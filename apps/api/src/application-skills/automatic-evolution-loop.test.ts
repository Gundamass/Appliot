import { describe, expect, it, vi } from "vitest";
import type { ApplicationSkillVersion, SkillEvaluation, SkillExecutionRecord } from "@resume/contracts";
import {
  AutomaticEvolutionLoop,
  type AutomaticEvolutionRegistry,
  type EvolutionQualificationPort
} from "./automatic-evolution-loop.js";
import type { PromotionEvaluationSample } from "./promotion-engine.js";
import type { SkillPageAllocation } from "./skill-selector.js";

describe("AutomaticEvolutionLoop", () => {
  it("collects audited Champion failures, qualifies the next patch, and activates it at ten percent", async () => {
    const registry = new MemoryRegistry(samples());
    const qualify = vi.fn(async (input: Parameters<EvolutionQualificationPort["qualify"]>[0]) => ({
      kind: "qualified" as const,
      candidate: version("1.0.1", "replay_qualified"),
      reportId: "evolution-report-1"
    }));
    const loop = new AutomaticEvolutionLoop({ registry, qualifier: { qualify }, now: () => "2026-09-07T12:00:00.000Z" });

    const result = await loop.recordAndEvolve(samples().at(-1)!);

    expect(result).toMatchObject({ kind: "activated", candidateVersion: "1.0.1" });
    expect(qualify).toHaveBeenCalledWith(expect.objectContaining({
      parent: expect.objectContaining({ version: "1.0.0" }),
      candidateVersion: "1.0.1",
      binding: expect.objectContaining({ version: "1.0.1", allocationId: "allocation-main" })
    }));
    expect(registry.activations).toEqual([expect.objectContaining({
      championVersion: "1.0.0",
      challengerVersion: "1.0.1",
      challengerPermille: 100
    })]);
  });

  it("does not start another evolution while a Challenger is active", async () => {
    const registry = new MemoryRegistry(samples());
    registry.allocation = { ...registry.allocation, challengerVersion: "1.1.0", championPercent: 90, challengerPercent: 10 };
    const qualify = vi.fn();

    expect(await new AutomaticEvolutionLoop({ registry, qualifier: { qualify } })
      .recordAndEvolve(samples().at(-1)!)).toEqual({ kind: "continue" });
    expect(qualify).not.toHaveBeenCalled();
  });

  it("isolates qualification failures from the active Champion", async () => {
    const registry = new MemoryRegistry(samples());
    const loop = new AutomaticEvolutionLoop({
      registry,
      qualifier: { qualify: async () => { throw new Error("provider unavailable"); } }
    });

    expect(await loop.recordAndEvolve(samples().at(-1)!)).toMatchObject({
      kind: "rejected",
      reason: "qualification_failed"
    });
    expect(registry.activations).toEqual([]);
    expect(registry.current.status).toBe("champion");
  });
});

function samples(): PromotionEvaluationSample[] {
  return [1, 2, 3, 4].map((index) => {
    const success = index === 4;
    const record: SkillExecutionRecord = {
      recordId: `auto-record-${index}`,
      taskId: `auto-task-${index}`,
      attemptId: `auto-attempt-${index}`,
      binding: {
        skillId: "baidu-application",
        version: "1.0.0",
        site: "baidu",
        pageFingerprintHash: "a".repeat(64),
        allocationId: "allocation-main"
      },
      pageVariantId: "application-form",
      allocation: "champion",
      fieldOutcomes: success
        ? [{ semantic: "basics.name", outcome: "verified" }]
        : [{ semantic: "basics.name", outcome: "failed", errorClass: "field_missing" }],
      counts: { observed: 1, planned: 1, verified: success ? 1 : 0, auditMismatches: 0, userCorrections: 0 },
      auditMismatchClasses: [],
      retries: 0,
      recoveries: 0,
      durationMs: 10,
      terminalResult: success ? "completed_pre_submit" : "failed",
      ...(success ? {} : {
        firstError: { stage: "resolve" as const, semantic: "basics.name" as const, errorClass: "field_missing" as const }
      }),
      startedAt: `2026-09-07T11:00:0${index}.000Z`,
      completedAt: `2026-09-07T11:00:0${index}.500Z`
    };
    const evaluation: SkillEvaluation = {
      evaluationId: `auto-evaluation-${index}`,
      executionRecordId: record.recordId,
      evaluatorVersion: "1.0.0",
      source: "online",
      safetyViolations: 0,
      incorrectWrites: 0,
      fieldAccuracy: success ? 1 : 0,
      requiredCompletion: success ? 1 : 0,
      userCorrections: 0,
      retries: 0,
      recoveries: 0,
      durationMs: 10,
      decision: success ? "pass" : "fail",
      evaluatedAt: record.completedAt
    };
    return { record, evaluation, scenarioClass: "stable", requiredFieldCount: 1, newAuditMismatches: 0 };
  });
}

function version(value: string, status: ApplicationSkillVersion["status"]): ApplicationSkillVersion {
  return {
    skillId: "baidu-application",
    version: value,
    schemaVersion: 1,
    contentHash: "b".repeat(64),
    site: "baidu",
    allowedDomains: ["talent.baidu.com"],
    pageFingerprintRule: { ruleId: "baidu-form", ruleHash: "c".repeat(64) },
    status,
    content: { capabilities: [], pageVariants: [], fields: [], workflow: [], recovery: { maxRetries: 0, actions: [] } },
    createdBy: { kind: "manual_seed", actorId: "test" },
    createdAt: "2026-09-07T10:00:00.000Z"
  };
}

class MemoryRegistry implements AutomaticEvolutionRegistry {
  current = version("1.0.0", "champion");
  activations: unknown[] = [];
  allocation: SkillPageAllocation = {
    allocationId: "allocation-main",
    skillId: "baidu-application",
    site: "baidu" as const,
    pageFingerprintHash: "a".repeat(64),
    championVersion: "1.0.0",
    championPercent: 100,
    challengerPercent: 0,
    updatedAt: "2026-09-07T10:00:00.000Z"
  };

  public constructor(private readonly evaluations: PromotionEvaluationSample[]) {}
  listPromotionEvaluations() { return this.evaluations; }
  getPageAllocation() { return this.allocation; }
  getVersion(_skillId: string, requested: string) { return requested === this.current.version ? this.current : undefined; }
  activateChallenger(input: unknown) { this.activations.push(input); return true; }
}
