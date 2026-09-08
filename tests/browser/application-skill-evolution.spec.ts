import { expect, test, type Page } from "@playwright/test";
import type {
  ApplicationSkillVersion,
  SkillBinding,
  SkillEvaluation,
  SkillExecutionRecord
} from "../../packages/contracts/src/index.js";
import { bootstrapApplicationSkills } from "../../apps/api/src/application-skills/bootstrap.js";
import { AutomaticEvolutionLoop } from "../../apps/api/src/application-skills/automatic-evolution-loop.js";
import { evaluateExecution } from "../../apps/api/src/application-skills/evaluation-engine.js";
import { collectEvolutionOpportunities } from "../../apps/api/src/application-skills/evolution-collector.js";
import {
  createEvolutionCoordinator,
  type OfflineReplayRunner
} from "../../apps/api/src/application-skills/evolution-coordinator.js";
import { PromotionEngine } from "../../apps/api/src/application-skills/promotion-engine.js";
import type { RedactedReplaySample } from "../../apps/api/src/application-skills/replay-corpus.js";
import {
  stratifiedBootstrapComparison,
  type StratifiedBootstrapResult
} from "../../apps/api/src/application-skills/statistics.js";
import {
  canonicalSkillContentHash,
  SkillRegistry
} from "../../apps/api/src/application-skills/skill-registry.js";
import {
  createApplicationSkillRuntime,
  SkillSelector,
  type SkillBindingStorePort
} from "../../apps/api/src/application-skills/skill-selector.js";
import { createSqliteDatabase } from "../../apps/api/src/db/client.js";
import { migrateDatabase } from "../../apps/api/src/db/migrate.js";
import { startSyntheticAts } from "../../apps/synthetic-ats/src/server.js";

const FINGERPRINT = "004c4bb7116a509a332df5f17b4553b04129d05383a02a693447622a4f5f6fc3";
const ALLOCATION_ID = "allocation-baidu-evolution-e2e";
const ACTIVATED_AT = "2026-09-07T12:00:00.000Z";
const SCOPE = {
  site: "baidu" as const,
  pageFingerprintHash: FINGERPRINT,
  skillId: "baidu-application",
  version: "1.0.0"
};

test("audited evolution promotes a verified Challenger and immediately rolls back a mutated successor", async ({ page }, testInfo) => {
  const server = await startSyntheticAts();
  const database = createSqliteDatabase(":memory:");
  try {
    migrateDatabase(database);
    const registry = new SkillRegistry(database);
    bootstrapApplicationSkills(registry);
    const parent = registry.getVersion(SCOPE.skillId, SCOPE.version)!;
    registry.bindPage(binding("1.0.0"));
    registry.setAllocation({
      ...SCOPE,
      allocationId: ALLOCATION_ID,
      championVersion: "1.0.0",
      championPercent: 100,
      challengerPercent: 0,
      updatedAt: "2026-09-07T11:00:00.000Z"
    });

    await openScenario(page, server.baseUrl, "evolution-label-change", "evolution-label");
    await expect(page.locator('input[placeholder="Preferred identity"]')).toHaveCount(1);
    await expect(page.locator('[data-semantic="basics.name"]')).toHaveCount(0);
    await testInfo.attach("baidu-evolution-label-change", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png"
    });

    const historical = [
      execution(1, binding("1.0.0"), "champion", "failure"),
      execution(2, binding("1.0.0"), "champion", "failure"),
      execution(3, binding("1.0.0"), "champion", "failure"),
      execution(4, binding("1.0.0"), "champion", "success")
    ];
    const historicalEvaluations = historical.map((record) => persistEvaluation(registry, record));
    const [opportunity] = collectEvolutionOpportunities({
      scope: SCOPE,
      executionRecords: historical,
      evaluations: historicalEvaluations,
      fingerprintObservations: [],
      openOpportunityIds: []
    });
    expect(opportunity).toMatchObject({
      triggers: ["repeated_actionable_failure"],
      occurrenceCount: 3,
      failToSuccessPair: {
        failureRecordId: historical[2]!.recordId,
        successRecordId: historical[3]!.recordId
      }
    });

    const candidateContent = structuredClone(parent.content);
    candidateContent.fields[0]!.locatorHints.push({
      key: "preferred-identity",
      by: "placeholder",
      text: "Preferred identity"
    });
    const coordinator = createEvolutionCoordinator({
      registry,
      generator: {
        async generate() {
          return {
            kind: "candidate",
            content: candidateContent,
            contentHash: canonicalSkillContentHash(candidateContent)
          };
        }
      },
      corpus: {
        snapshotForEvolution: (cutoffAt) => ({
          manifestId: "replay-manifest-evolution-e2e",
          cutoffAt,
          trainingCount: 1,
          training: {
            list: () => [{ sampleId: "training-evolution-1", partition: "training" }] as never,
            get: () => undefined
          }
        })
      },
      holdout: {
        openHoldout: () => ({
          manifest: { manifestId: "replay-manifest-evolution-e2e" } as never,
          samples: holdoutSamples()
        })
      },
      safetySimulator: { evaluate: async () => ({ safe: true, incorrectWrites: 0, mismatches: 0 }) },
      replayRunner: deterministicReplayRunner(),
      syntheticAts: {
        evaluate: async () => ({
          safe: true,
          incorrectWrites: 0,
          mismatches: 0,
          scenarios: [
            "reordered-controls",
            "duplicate-label",
            "delayed-options",
            "hidden-honeypot",
            "unexpected-navigation",
            "stale-node",
            "post-fill-mutation",
            "evolution-label-change"
          ]
        })
      }
    });
    const store = new MemoryBindingStore();
    const selector = new SkillSelector(registry, store);
    const existingTask = await select(selector, "task-existing-before-activation", "2026-09-07T11:40:00.000Z");
    expect(existingTask.version).toBe("1.0.0");
    const automatic = new AutomaticEvolutionLoop({ registry, qualifier: coordinator, now: () => ACTIVATED_AT });
    const activation = await automatic.recordAndEvolve({
      record: historical.at(-1)!,
      evaluation: historicalEvaluations.at(-1)!,
      scenarioClass: "evolution-label-change",
      requiredFieldCount: 1,
      newAuditMismatches: 0
    });
    expect(activation).toMatchObject({ kind: "activated", candidateVersion: "1.0.1" });
    const activatedCandidate = registry.getVersion(SCOPE.skillId, "1.0.1");
    expect(activatedCandidate?.status).toBe("challenger");
    expect(activatedCandidate?.content.fields[0]?.locatorHints).toContainEqual({
      key: "preferred-identity",
      by: "placeholder",
      text: "Preferred identity"
    });
    expect((await select(selector, "task-existing-before-activation", "2026-09-07T12:01:00.000Z")).version)
      .toBe("1.0.0");

    const cohorts = await selectCohorts(selector, "promotion", "1.0.1");
    expect(cohorts.champion).toHaveLength(10);
    expect(cohorts.challenger).toHaveLength(10);
    const comparisons: StratifiedBootstrapResult[] = [];
    const promotion = new PromotionEngine({
      registry,
      compare(input) {
        const result = stratifiedBootstrapComparison(input);
        comparisons.push(result);
        return result;
      }
    });
    for (const [index, selected] of cohorts.champion.entries()) {
      await promoteSample(promotion, registry, execution(100 + index, selected, "champion", "baseline"));
    }
    let promotionDecision = "continue";
    for (const [index, selected] of cohorts.challenger.entries()) {
      promotionDecision = (await promoteSample(
        promotion,
        registry,
        execution(200 + index, selected, "challenger", "success")
      )).kind;
    }
    expect(promotionDecision, JSON.stringify(comparisons.at(-1))).toBe("promoted");
    expect(comparisons.at(-1)).toMatchObject({
      championCount: 10,
      challengerCount: 10,
      eligibleChallengerCount: 10,
      firstDifferingDimension: "retriesAndRecoveries",
      observedDelta: 1,
      confidenceInterval95: [1, 1],
      decision: "promote"
    });
    expect(registry.getVersion(SCOPE.skillId, "1.0.0")?.status).toBe("retired");
    expect(registry.getVersion(SCOPE.skillId, "1.0.1")?.status).toBe("champion");
    expect(registry.getPageAllocation(SCOPE)).toMatchObject({
      championVersion: "1.0.1",
      championPercent: 100,
      challengerPercent: 0
    });
    expect(await store.get("task-existing-before-activation")).toMatchObject({ version: "1.0.0" });

    const successor = successorVersion(registry.getVersion(SCOPE.skillId, "1.0.1")!);
    expect(registry.createVersion(successor).created).toBe(true);
    registry.bindPage(binding("1.0.2"));
    expect(registry.compareAndSetStatus(SCOPE, "candidate", "replay_qualified", "1.0.2")).toBe(true);
    const stableStore = new MemoryBindingStore();
    const stableSelector = new SkillSelector(registry, stableStore);
    expect((await select(stableSelector, "task-stable-before-rollback-trial", "2026-09-07T13:00:00.000Z")).version)
      .toBe("1.0.1");
    expect(registry.activateChallenger({
      ...SCOPE,
      allocationId: ALLOCATION_ID,
      championVersion: "1.0.1",
      challengerVersion: "1.0.2",
      challengerPermille: 100,
      activatedAt: "2026-09-07T14:00:00.000Z"
    })).toBe(true);
    const rollbackCohorts = await selectCohorts(stableSelector, "rollback", "1.0.2", 1);
    const challengerBinding = rollbackCohorts.challenger[0]!;
    await openScenario(page, server.baseUrl, "post-fill-mutation", "rollback-mutation");
    await page.locator('[data-semantic="basics.name"]').fill("Evolution Candidate");
    await expect(page.locator('[data-semantic="basics.name"]')).toHaveValue("POST_FILL_MUTATION");
    await page.evaluate(async () => {
      await (window as unknown as { skillRuntimeFixture?: { flush(): Promise<unknown> } }).skillRuntimeFixture?.flush();
    });
    await testInfo.attach("baidu-challenger-post-fill-mutation", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png"
    });

    const unsafe = execution(300, challengerBinding, "challenger", "audit-mismatch");
    const rollbackStartedAt = performance.now();
    const rollback = await promoteSample(promotion, registry, unsafe);
    const rollbackLatencyMs = performance.now() - rollbackStartedAt;
    expect(rollback.kind).toBe("rolled_back");
    expect(rollbackLatencyMs).toBeLessThan(1_000);
    expect(registry.getVersion(SCOPE.skillId, "1.0.2")?.status).toBe("quarantined");
    expect(registry.getPageAllocation(SCOPE)).toMatchObject({
      championVersion: "1.0.1",
      championPercent: 100,
      challengerPercent: 0
    });
    const pinnedChallenger = stableStore.entryForVersion("1.0.2");
    expect(pinnedChallenger?.binding.version).toBe("1.0.2");
    const resumed = await createApplicationSkillRuntime({
      registry,
      bindingStoreFor: () => stableStore
    }).resolve({
      runId: "run-quarantined-resume",
      taskId: pinnedChallenger!.taskId,
      binding: pinnedChallenger!.binding,
      snapshot: {
        id: "snapshot-quarantined-resume",
        taskId: pinnedChallenger!.taskId,
        url: "https://talent.baidu.com/jobs/detail/GRADUATE/job-1/apply",
        title: "申请职位 - 个人信息",
        stage: "application_form",
        frameRef: { documentId: "document-quarantined", kind: "main" },
        mutationEpoch: 1,
        fields: [{
          id: "candidate-name",
          label: "姓名",
          type: "text",
          required: true,
          options: [],
          currentValue: "",
          semanticHint: "basics.name",
          nodeRef: { documentId: "document-quarantined", nodeId: "node-name", observedAt: 1 }
        }],
        actions: [],
        errors: []
      }
    });
    expect(resumed).toEqual({ kind: "observe_only_handoff", reason: "safe_version_unavailable" });
    expect((await select(stableSelector, "task-stable-before-rollback-trial", "2026-09-07T14:10:00.000Z")).version)
      .toBe("1.0.1");
    expect((await select(stableSelector, "task-fresh-after-rollback", "2026-09-07T14:10:00.000Z")).version)
      .toBe("1.0.1");

    const evidenceCount = database.prepare("SELECT COUNT(*) AS count FROM skill_execution_records").get() as { count: number };
    expect(evidenceCount.count).toBe(25);
    expect(() => database.prepare("UPDATE skill_execution_records SET payload_json = '{}' WHERE record_id = ?")
      .run(unsafe.recordId)).toThrow();
    expect(server.state("evolution-label").submissionCount).toBe(0);
    expect(server.state("rollback-mutation").submissionCount).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM skill_versions WHERE skill_id = 'baidu-application' AND status = 'champion'").get())
      .toEqual({ count: 1 });
    const evaluationIds = (database.prepare(
      "SELECT evaluation_id FROM skill_evaluations ORDER BY evaluated_at, evaluation_id"
    ).all() as Array<{ evaluation_id: string }>).map(({ evaluation_id }) => evaluation_id);
    await testInfo.attach("skill-evolution-audit.json", {
      body: Buffer.from(JSON.stringify({
        allocationId: ALLOCATION_ID,
        promotion: comparisons.at(-1),
        rollbackLatencyMs,
        evidenceCount: evidenceCount.count,
        evaluationIds,
        submissionCounts: {
          labelChange: server.state("evolution-label").submissionCount,
          rollbackMutation: server.state("rollback-mutation").submissionCount
        }
      }, null, 2)),
      contentType: "application/json"
    });
  } finally {
    database.close();
    await server.close();
  }
});

async function openScenario(page: Page, baseUrl: string, scenario: string, taskId: string): Promise<void> {
  await page.goto(`${baseUrl}/skill-runtime?taskId=${taskId}&site=baidu&scenario=${scenario}`);
  await expect(page.locator('body[data-fixture="application-skill-runtime"]')).toHaveAttribute("data-site", "baidu");
}

function binding(version: string): SkillBinding {
  return {
    skillId: SCOPE.skillId,
    version,
    site: SCOPE.site,
    pageFingerprintHash: FINGERPRINT,
    allocationId: ALLOCATION_ID
  };
}

function execution(
  index: number,
  selectedBinding: SkillBinding,
  allocation: "champion" | "challenger",
  outcome: "failure" | "baseline" | "success" | "audit-mismatch"
): SkillExecutionRecord {
  const windowStart = index < 10
    ? Date.parse("2026-09-07T11:10:00.000Z")
    : index >= 300
      ? Date.parse("2026-09-07T14:00:00.000Z")
      : Date.parse(ACTIVATED_AT);
  const completedAt = new Date(windowStart + (index + 1) * 1_000).toISOString();
  const failure = outcome === "failure";
  const mismatch = outcome === "audit-mismatch";
  const baseline = outcome === "baseline";
  return {
    recordId: `evolution-record-${index}`,
    taskId: `evolution-task-${index}`,
    attemptId: `evolution-attempt-${index}`,
    binding: selectedBinding,
    pageVariantId: "application-form",
    allocation,
    fieldOutcomes: failure
      ? [{ semantic: "basics.name", outcome: "failed", errorClass: "field_missing" }]
      : [{ semantic: "basics.name", outcome: "verified" }],
    counts: {
      observed: 1,
      planned: 1,
      verified: failure ? 0 : 1,
      auditMismatches: mismatch ? 1 : 0,
      userCorrections: 0
    },
    auditMismatchClasses: mismatch ? ["unexpected_value"] : [],
    retries: baseline ? 1 : 0,
    recoveries: 0,
    durationMs: baseline ? 100 : 10,
    terminalResult: failure || mismatch ? "failed" : "completed_pre_submit",
    ...(failure ? {
      firstError: { stage: "resolve" as const, semantic: "basics.name" as const, errorClass: "field_missing" as const }
    } : {}),
    startedAt: new Date(Date.parse(completedAt) - 10).toISOString(),
    completedAt
  };
}

function persistEvaluation(registry: SkillRegistry, record: SkillExecutionRecord): SkillEvaluation {
  registry.appendExecutionRecord(record);
  const evaluation = evaluateExecution({
    record,
    requiredSemantics: ["basics.name"],
    auditCompleted: true,
    source: "online",
    evaluatedAt: record.completedAt
  }).evaluation;
  registry.appendEvaluation(evaluation);
  return evaluation;
}

async function promoteSample(engine: PromotionEngine, registry: SkillRegistry, record: SkillExecutionRecord) {
  registry.appendExecutionRecord(record);
  const evaluation = evaluateExecution({
    record,
    requiredSemantics: ["basics.name"],
    auditCompleted: true,
    source: "online",
    evaluatedAt: record.completedAt
  }).evaluation;
  return engine.recordAndDecide({
    record,
    evaluation,
    scenarioClass: "stable",
    requiredFieldCount: 1,
    newAuditMismatches: record.counts.auditMismatches
  });
}

async function select(selector: SkillSelector, taskId: string, taskCreatedAt: string): Promise<SkillBinding> {
  const result = await selector.selectForTask({ taskId, ...SCOPE, taskCreatedAt });
  if (result.kind !== "selected") throw new Error(`skill_selection_failed:${result.reason}`);
  return result.binding;
}

async function selectCohorts(
  selector: SkillSelector,
  prefix: string,
  challengerVersion: string,
  target = 10
): Promise<{ champion: SkillBinding[]; challenger: SkillBinding[] }> {
  const result: { champion: SkillBinding[]; challenger: SkillBinding[] } = { champion: [], challenger: [] };
  for (let index = 0; index < 2_000 && (result.champion.length < target || result.challenger.length < target); index += 1) {
    const selected = await select(selector, `task-${prefix}-${index}`, "2026-09-07T15:00:00.000Z");
    const cohort = selected.version === challengerVersion ? result.challenger : result.champion;
    if (cohort.length < target) cohort.push(selected);
  }
  return result;
}

function successorVersion(champion: ApplicationSkillVersion): ApplicationSkillVersion {
  const content = structuredClone(champion.content);
  content.fields[0]!.locatorHints.push({ key: "rollback-trial", by: "label", text: "Preferred identity" });
  return {
    ...champion,
    version: "1.0.2",
    parentVersion: champion.version,
    status: "candidate",
    content,
    contentHash: canonicalSkillContentHash(content),
    createdBy: {
      kind: "evolution_agent",
      actorId: "skill-evolution-agent",
      evolutionRunId: "evolution-run-rollback-e2e"
    },
    createdAt: "2026-09-07T13:30:00.000Z"
  };
}

function deterministicReplayRunner(): OfflineReplayRunner {
  return {
    evaluate: async ({ skill, samples }) => samples.map((sample) => ({
      sampleId: sample.sampleId,
      evaluation: replayEvaluation(skill, sample.sampleId)
    }))
  };
}

function replayEvaluation(skill: ApplicationSkillVersion, sampleId: string): SkillEvaluation {
  const candidate = skill.status === "candidate";
  const suffix = `${skill.version.replaceAll(".", "-")}-${sampleId}`;
  return {
    evaluationId: `evaluation-${suffix}`,
    executionRecordId: `execution-${suffix}`,
    evaluatorVersion: "1.0.0",
    source: "replay",
    safetyViolations: 0,
    incorrectWrites: 0,
    fieldAccuracy: candidate ? 1 : 0,
    requiredCompletion: candidate ? 1 : 0,
    userCorrections: 0,
    retries: candidate ? 0 : 1,
    recoveries: 0,
    durationMs: candidate ? 10 : 100,
    decision: candidate ? "pass" : "fail",
    evaluatedAt: "2026-09-07T11:30:00.000Z"
  };
}

function holdoutSamples(): RedactedReplaySample[] {
  return ["holdout-evolution-1", "holdout-evolution-2"].map((sampleId) => ({
    sampleId,
    capturedAt: "2026-09-07T11:00:00.000Z",
    site: "baidu",
    pageFingerprintHash: FINGERPRINT,
    scenarioClass: "evolution-label-change",
    controls: [],
    expectedSemantics: ["basics.name"],
    observedOutcome: {
      counts: { verified: 0, observed: 1, planned: 1, auditMismatches: 0, userCorrections: 0 },
      fieldOutcomes: [{ semantic: "basics.name", outcome: "failed", errorClass: "field_missing" }],
      auditMismatchClasses: [],
      terminalResult: "failed",
      retries: 0,
      recoveries: 0,
      durationMs: 10,
      firstError: { stage: "resolve", semantic: "basics.name", errorClass: "field_missing" }
    },
    partition: "holdout"
  }));
}

class MemoryBindingStore implements SkillBindingStorePort {
  private readonly bindings = new Map<string, SkillBinding>();

  public async get(taskId: string): Promise<SkillBinding | undefined> {
    return this.bindings.get(taskId);
  }

  public async putIfAbsent(taskId: string, value: SkillBinding): Promise<SkillBinding> {
    const existing = this.bindings.get(taskId);
    if (existing !== undefined) return existing;
    this.bindings.set(taskId, value);
    return value;
  }

  public entryForVersion(version: string): { taskId: string; binding: SkillBinding } | undefined {
    for (const [taskId, binding] of this.bindings) {
      if (binding.version === version) return { taskId, binding };
    }
    return undefined;
  }
}
