import { describe, expect, it } from "vitest";
import type { SkillEvaluation, SkillExecutionRecord } from "@resume/contracts";
import { collectEvolutionOpportunities, type EvolutionCollectorInput } from "./evolution-collector.js";

describe("Skill evolution opportunity collector", () => {
  it("triggers on three equivalent actionable failures in the latest twenty eligible executions", () => {
    const records = Array.from({ length: 21 }, (_, offset) => {
      const index = offset + 1;
      return execution(index, index >= 19 ? {
        terminalResult: "failed",
        firstError: { stage: "resolve", errorClass: "field_missing", semantic: "basics.email" }
      } : {});
    });
    const evaluations = records.map((record, offset) => evaluation(record, {
      fieldAccuracy: offset >= 18 ? 0 : 1,
      requiredCompletion: offset >= 18 ? 0 : 1,
      decision: offset >= 18 ? "fail" : "pass"
    }));

    const opportunities = collectEvolutionOpportunities(input({ records, evaluations }));

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({
      opportunityId: expect.stringMatching(/^evolution-opportunity-[a-f0-9]{32}$/u),
      scope: targetScope,
      theme: {
        pageVariantId: "application-form",
        semantic: "basics.email",
        errorClass: "field_missing"
      },
      triggers: ["repeated_actionable_failure"],
      occurrenceCount: 3,
      aggregate: { sampleCount: 20 }
    });
    expect(opportunities[0]!.evidenceRecordIds).toEqual([
      "skill-record-19",
      "skill-record-20",
      "skill-record-21"
    ]);
    expect(Object.isFrozen(opportunities[0])).toBe(true);
  });

  it("does not trigger for duplicate attempts, unrelated scopes, old versions, or browser ownership loss", () => {
    const ownershipFailures = [1, 2, 3].map((index) => execution(index, {
      terminalResult: "failed",
      firstError: { stage: "observe", errorClass: "browser_ownership_lost" }
    }));
    const oneActionable = execution(4, {
      terminalResult: "failed",
      firstError: { stage: "resolve", errorClass: "field_missing", semantic: "basics.email" }
    });
    const unrelatedSite = execution(5, {
      binding: { ...execution(5).binding, site: "moka" },
      terminalResult: "failed",
      firstError: { stage: "resolve", errorClass: "field_missing", semantic: "basics.email" }
    });
    const oldVersion = execution(6, {
      binding: { ...execution(6).binding, version: "0.9.0" },
      terminalResult: "failed",
      firstError: { stage: "resolve", errorClass: "field_missing", semantic: "basics.email" }
    });
    const records = [...ownershipFailures, oneActionable, oneActionable, unrelatedSite, oldVersion];

    expect(collectEvolutionOpportunities(input({
      records,
      evaluations: records.map((record) => evaluation(record, { decision: "fail" }))
    }))).toEqual([]);
  });

  it("takes the latest twenty evaluated executions after excluding records without evaluations", () => {
    const records = Array.from({ length: 24 }, (_, offset) => {
      const index = offset + 1;
      return execution(index, index >= 2 && index <= 4 ? {
        terminalResult: "failed",
        firstError: failure("basics.email")
      } : {});
    });
    const evaluations = records.slice(0, 21).map((record) => evaluation(record, {
      decision: record.terminalResult === "failed" ? "fail" : "pass"
    }));

    const opportunities = collectEvolutionOpportunities(input({ records, evaluations }));

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]!.evidenceRecordIds).toEqual([
      "skill-record-2",
      "skill-record-3",
      "skill-record-4"
    ]);
    expect(opportunities[0]!.aggregate?.sampleCount).toBe(20);
  });

  it("triggers fingerprint drift only after two observations confirm no usable Champion", () => {
    const observations: EvolutionCollectorInput["fingerprintObservations"] = [
      observation("fingerprint-observation-1", false),
      observation("fingerprint-observation-2", false)
    ];

    const opportunities = collectEvolutionOpportunities(input({ observations }));

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({
      theme: { pageVariantId: "unknown", errorClass: "fingerprint_drift" },
      triggers: ["fingerprint_drift"],
      occurrenceCount: 2,
      aggregate: undefined
    });
    expect(collectEvolutionOpportunities(input({ observations: [observations[0]!] }))).toEqual([]);
    expect(collectEvolutionOpportunities(input({
      observations: [...observations, observation("fingerprint-observation-3", true)]
    }))).toEqual([]);
  });

  it("triggers for an improving Challenger that repeats the same recovery at least three times", () => {
    const records = [1, 2, 3].map((index) => execution(index, {
      allocation: "challenger",
      terminalResult: "failed",
      recoveries: 1,
      firstError: { stage: "readback", errorClass: "readback_mismatch", semantic: "basics.email" }
    }));
    const evaluations = records.map((record, index) => evaluation(record, {
      incorrectWrites: 0,
      fieldAccuracy: 0.6 + index * 0.1,
      requiredCompletion: 0.5 + index * 0.1,
      recoveries: 1,
      decision: "fail"
    }));

    const [opportunity] = collectEvolutionOpportunities(input({ records, evaluations }));

    expect(opportunity).toMatchObject({
      triggers: ["challenger_repeated_recovery"],
      occurrenceCount: 3,
      theme: { semantic: "basics.email", errorClass: "readback_mismatch" }
    });
    expect(opportunity!.executionChain.map(({ recordId }) => recordId)).toEqual([
      "skill-record-1",
      "skill-record-2",
      "skill-record-3"
    ]);
  });

  it("retains the shortest strictly improving fail-to-success pair", () => {
    const records = [
      execution(1, { terminalResult: "failed", firstError: failure("basics.email") }),
      execution(2, { terminalResult: "failed", firstError: failure("basics.email") }),
      execution(3, { fieldOutcomes: [{ semantic: "basics.email", outcome: "verified" }] }),
      execution(4, { terminalResult: "failed", firstError: failure("basics.email") }),
      execution(5, { fieldOutcomes: [{ semantic: "basics.email", outcome: "verified" }] })
    ];
    const evaluations = [
      evaluation(records[0]!, { fieldAccuracy: 0.2, requiredCompletion: 0, decision: "fail" }),
      evaluation(records[1]!, { fieldAccuracy: 0.4, requiredCompletion: 0.2, decision: "fail" }),
      evaluation(records[2]!, { fieldAccuracy: 0.8, requiredCompletion: 0.8, decision: "pass" }),
      evaluation(records[3]!, { fieldAccuracy: 0.5, requiredCompletion: 0.5, decision: "fail" }),
      evaluation(records[4]!, { fieldAccuracy: 1, requiredCompletion: 1, decision: "pass" })
    ];

    const [opportunity] = collectEvolutionOpportunities(input({ records, evaluations }));

    expect(opportunity!.failToSuccessPair).toEqual({
      failureRecordId: "skill-record-4",
      successRecordId: "skill-record-5",
      distance: 1
    });
    expect(opportunity!.executionChain.map(({ recordId }) => recordId)).toEqual([
      "skill-record-4",
      "skill-record-5"
    ]);
  });

  it("suppresses a theme while an evolution run for its stable opportunity id is open", () => {
    const records = [1, 2, 3].map((index) => execution(index, {
      terminalResult: "failed",
      firstError: failure("basics.email")
    }));
    const evaluations = records.map((record) => evaluation(record, { decision: "fail" }));
    const first = collectEvolutionOpportunities(input({ records, evaluations }));

    expect(first).toHaveLength(1);
    expect(collectEvolutionOpportunities(input({
      records: [...records, execution(4, { terminalResult: "failed", firstError: failure("basics.email") })],
      evaluations: [...evaluations, evaluation(execution(4), { decision: "fail" })],
      openOpportunityIds: [first[0]!.opportunityId]
    }))).toEqual([]);
  });

  it("fails closed when one logical attempt is presented with conflicting evidence", () => {
    const original = execution(1);

    expect(() => collectEvolutionOpportunities(input({
      records: [original, { ...original, durationMs: original.durationMs + 1 }],
      evaluations: [evaluation(original)]
    }))).toThrow("skill_execution_duplicate_conflict");
  });
});

const targetScope = {
  site: "baidu" as const,
  pageFingerprintHash: "a".repeat(64),
  skillId: "baidu-application",
  version: "1.0.0"
};

function input(overrides: {
  records?: SkillExecutionRecord[];
  evaluations?: SkillEvaluation[];
  observations?: EvolutionCollectorInput["fingerprintObservations"];
  openOpportunityIds?: string[];
} = {}): EvolutionCollectorInput {
  return {
    scope: targetScope,
    executionRecords: overrides.records ?? [],
    evaluations: overrides.evaluations ?? [],
    fingerprintObservations: overrides.observations ?? [],
    openOpportunityIds: overrides.openOpportunityIds ?? []
  };
}

function execution(index: number, overrides: Partial<SkillExecutionRecord> = {}): SkillExecutionRecord {
  const suffix = String(index).padStart(2, "0");
  return {
    recordId: `skill-record-${index}`,
    taskId: `task-${index}`,
    attemptId: `attempt-${index}`,
    binding: {
      skillId: targetScope.skillId,
      version: targetScope.version,
      site: targetScope.site,
      pageFingerprintHash: targetScope.pageFingerprintHash,
      allocationId: "allocation-main"
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
    startedAt: `2026-09-07T08:00:${suffix}.000Z`,
    completedAt: `2026-09-07T08:00:${suffix}.500Z`,
    ...overrides
  };
}

function evaluation(record: SkillExecutionRecord, overrides: Partial<SkillEvaluation> = {}): SkillEvaluation {
  return {
    evaluationId: `evaluation-${record.recordId.replace("skill-record-", "")}`,
    executionRecordId: record.recordId,
    evaluatorVersion: "1.0.0",
    source: "online",
    safetyViolations: 0,
    incorrectWrites: 0,
    fieldAccuracy: 1,
    requiredCompletion: 1,
    userCorrections: 0,
    retries: record.retries,
    recoveries: record.recoveries,
    durationMs: record.durationMs,
    decision: "pass",
    evaluatedAt: record.completedAt,
    ...overrides
  };
}

function observation(observationId: string, hasUsableChampion: boolean) {
  return {
    observationId,
    site: targetScope.site,
    pageFingerprintHash: targetScope.pageFingerprintHash,
    observedAt: "2026-09-07T08:30:00.000Z",
    hasUsableChampion
  };
}

function failure(semantic: "basics.email") {
  return { stage: "resolve" as const, errorClass: "field_missing" as const, semantic };
}
