import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ApplicationSkillContent,
  ApplicationSkillVersion,
  SkillEvaluation,
  SkillExecutionRecord
} from "@resume/contracts";
import { migrateApplicationSkillSchema } from "./skill-schema-migration.js";
import {
  SkillRegistry,
  type SkillEvolutionRunRecord,
  type SkillPageKey,
  type SkillReplayRunSampleRecord,
  type SkillReplaySampleRecord
} from "./skill-registry.js";

const pageFingerprintHash = "a".repeat(64);
const pageFingerprintRuleHash = "b".repeat(64);
const key: SkillPageKey = {
  skillId: "baidu-application",
  site: "baidu",
  pageFingerprintHash
};

describe("application Skill schema migration", () => {
  it("creates all eight tables idempotently", () => {
    const database = new Database(":memory:");

    try {
      migrateApplicationSkillSchema(database);
      migrateApplicationSkillSchema(database);

      const tables = (database.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'skill_%'
        ORDER BY name
      `).all() as Array<{ name: string }>).map(({ name }) => name);

      expect(tables).toEqual([
        "skill_evaluations",
        "skill_evolution_runs",
        "skill_execution_records",
        "skill_page_bindings",
        "skill_replay_run_samples",
        "skill_replay_samples",
        "skill_traffic_allocations",
        "skill_versions"
      ]);
    } finally {
      database.close();
    }
  });
});

describe("SkillRegistry", () => {
  let database: Database.Database;
  let registry: SkillRegistry;

  beforeEach(() => {
    database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    migrateApplicationSkillSchema(database);
    registry = new SkillRegistry(database);
  });

  afterEach(() => {
    database.close();
  });

  it("stores and reads a validated version while deduplicating its canonical content hash", () => {
    const candidate = versionFixture("1.1.0", "candidate");

    expect(registry.createVersion(candidate)).toEqual({ created: true, version: "1.1.0" });
    expect(registry.createVersion(candidate)).toEqual({ created: false, version: "1.1.0" });
    expect(registry.getVersion(candidate.skillId, candidate.version)).toEqual(candidate);
    expect(database.prepare("SELECT COUNT(*) AS count FROM skill_versions").get()).toEqual({ count: 1 });
  });

  it("rejects a version whose declared hash is not the canonical content SHA-256", () => {
    const candidate = {
      ...versionFixture("1.1.0", "candidate"),
      contentHash: "f".repeat(64)
    };

    expect(() => registry.createVersion(candidate)).toThrowError("skill_content_hash_mismatch");
  });

  it("only admits candidate versions and explicit bootstrap champions", () => {
    expect(() => registry.createVersion(versionFixture("1.1.0", "retired")))
      .toThrowError("skill_initial_status_invalid");
    expect(() => registry.createVersion(versionFixture("1.2.0", "quarantined")))
      .toThrowError("skill_initial_status_invalid");
  });

  it("rejects direct mutation or deletion of immutable version data", () => {
    registry.createVersion(versionFixture("1.1.0", "candidate"));

    expect(() => database.prepare(`
      UPDATE skill_versions SET content_json = '{}' WHERE skill_id = ? AND version = ?
    `).run(key.skillId, "1.1.0")).toThrow();
    expect(() => database.prepare(`
      DELETE FROM skill_versions WHERE skill_id = ? AND version = ?
    `).run(key.skillId, "1.1.0")).toThrow();
  });

  it("enforces the legal lifecycle and permits quarantine from a hard failure", () => {
    registry.createVersion(versionFixture("1.1.0", "candidate"));
    registry.bindPage(binding("1.1.0", "allocation-main"));

    expect(registry.compareAndSetStatus(key, "candidate", "challenger", "1.1.0")).toBe(false);
    expect(registry.compareAndSetStatus(key, "candidate", "replay_qualified", "1.1.0")).toBe(true);
    expect(registry.compareAndSetStatus(key, "replay_qualified", "challenger", "1.1.0")).toBe(false);
    expect(registry.compareAndSetStatus(key, "replay_qualified", "quarantined", "1.1.0")).toBe(true);
    expect(registry.getVersion(key.skillId, "1.1.0")?.status).toBe("quarantined");
    expect(registry.compareAndSetStatus(key, "quarantined", "quarantined", "1.1.0")).toBe(false);
    expect(registry.compareAndSetStatus(key, "quarantined", "candidate", "1.1.0")).toBe(false);
  });

  it("allows exactly one winner across repeated compare-and-set promotion attempts", () => {
    registry.createVersion(versionFixture("1.0.0", "champion"));
    registry.bindPage(binding("1.0.0", "allocation-main"));
    registry.setAllocation({
      allocationId: "allocation-main", ...key, championVersion: "1.0.0",
      championPercent: 100, challengerPercent: 0, updatedAt: "2026-09-07T08:00:00.000Z"
    });
    registry.createVersion(versionFixture("1.1.0", "candidate", "1.0.0"));
    registry.bindPage(binding("1.1.0", "allocation-main"));
    expect(registry.compareAndSetStatus(key, "candidate", "replay_qualified", "1.1.0")).toBe(true);
    expect(registry.activateChallenger({
      allocationId: "allocation-main", ...key, championVersion: "1.0.0", challengerVersion: "1.1.0",
      challengerPermille: 100, activatedAt: "2026-09-07T09:00:00.000Z"
    })).toBe(true);

    expect([
      registry.compareAndSetStatus(key, "challenger", "champion", "1.1.0"),
      registry.compareAndSetStatus(key, "challenger", "champion", "1.1.0")
    ].filter(Boolean)).toHaveLength(1);
  });

  it("atomically activates exactly one replay-qualified Challenger at 10 percent", () => {
    registry.createVersion(versionFixture("1.0.0", "champion"));
    registry.bindPage(binding("1.0.0", "allocation-main"));
    registry.setAllocation({
      allocationId: "allocation-main",
      ...key,
      championVersion: "1.0.0",
      championPercent: 100,
      challengerPercent: 0,
      updatedAt: "2026-09-07T08:00:00.000Z"
    });
    registry.createVersion(versionFixture("1.1.0", "candidate", "1.0.0"));
    registry.bindPage(binding("1.1.0", "allocation-main"));
    registry.compareAndSetStatus(key, "candidate", "replay_qualified", "1.1.0");

    const activation = {
      ...key,
      allocationId: "allocation-main",
      championVersion: "1.0.0",
      challengerVersion: "1.1.0",
      challengerPermille: 100,
      activatedAt: "2026-09-07T09:00:00.000Z"
    };
    expect(registry.activateChallenger(activation)).toBe(true);
    expect(registry.activateChallenger(activation)).toBe(false);
    expect(registry.getVersion(key.skillId, "1.1.0")?.status).toBe("challenger");
    expect(registry.getPageAllocation(key)).toMatchObject({
      championVersion: "1.0.0",
      challengerVersion: "1.1.0",
      championPercent: 90,
      challengerPercent: 10,
      updatedAt: activation.activatedAt
    });
  });

  it("atomically retires an inconclusive Challenger and restores all traffic to the Champion", () => {
    registry.createVersion(versionFixture("1.0.0", "champion"));
    registry.bindPage(binding("1.0.0", "allocation-main"));
    registry.setAllocation({
      allocationId: "allocation-main",
      ...key,
      championVersion: "1.0.0",
      championPercent: 100,
      challengerPercent: 0,
      updatedAt: "2026-09-07T08:00:00.000Z"
    });
    registry.createVersion(versionFixture("1.1.0", "candidate", "1.0.0"));
    registry.bindPage(binding("1.1.0", "allocation-main"));
    registry.compareAndSetStatus(key, "candidate", "replay_qualified", "1.1.0");
    registry.activateChallenger({
      allocationId: "allocation-main",
      ...key,
      championVersion: "1.0.0",
      challengerVersion: "1.1.0",
      challengerPermille: 100,
      activatedAt: "2026-09-07T09:00:00.000Z"
    });

    const retirement = {
      allocationId: "allocation-main",
      ...key,
      championVersion: "1.0.0",
      challengerVersion: "1.1.0",
      retiredAt: "2026-09-07T10:00:00.000Z"
    };
    expect(registry.retireChallenger(retirement)).toBe(true);
    expect(registry.retireChallenger(retirement)).toBe(false);
    expect(registry.getVersion(key.skillId, "1.1.0")?.status).toBe("retired");
    const allocation = registry.getPageAllocation(key);
    expect(allocation).toMatchObject({
      championVersion: "1.0.0",
      championPercent: 100,
      challengerPercent: 0,
      updatedAt: retirement.retiredAt
    });
    expect(allocation).not.toHaveProperty("challengerVersion");
  });

  it("rejects a non-10-percent activation without changing lifecycle or allocation", () => {
    registry.createVersion(versionFixture("1.0.0", "champion"));
    registry.bindPage(binding("1.0.0", "allocation-main"));
    registry.setAllocation({
      allocationId: "allocation-main",
      ...key,
      championVersion: "1.0.0",
      championPercent: 100,
      challengerPercent: 0,
      updatedAt: "2026-09-07T08:00:00.000Z"
    });
    registry.createVersion(versionFixture("1.1.0", "candidate", "1.0.0"));
    registry.bindPage(binding("1.1.0", "allocation-main"));
    registry.compareAndSetStatus(key, "candidate", "replay_qualified", "1.1.0");

    expect(() => registry.activateChallenger({
      ...key,
      allocationId: "allocation-main",
      championVersion: "1.0.0",
      challengerVersion: "1.1.0",
      challengerPermille: 200,
      activatedAt: "2026-09-07T09:00:00.000Z"
    })).toThrowError("skill_challenger_allocation_invalid");
    expect(registry.getVersion(key.skillId, "1.1.0")?.status).toBe("replay_qualified");
    expect(registry.getPageAllocation(key)).toMatchObject({ championPercent: 100, challengerPercent: 0 });
  });

  it("keeps only one active champion and challenger per page fingerprint", () => {
    registry.createVersion(versionFixture("1.0.0", "champion"));
    registry.bindPage(binding("1.0.0", "allocation-main"));
    registry.createVersion(versionFixture("1.1.0", "candidate", "1.0.0"));
    registry.bindPage(binding("1.1.0", "allocation-main"));
    registry.createVersion(versionFixture("1.2.0", "candidate", "1.1.0"));
    registry.bindPage(binding("1.2.0", "allocation-main"));

    expect(registry.compareAndSetStatus(key, "candidate", "replay_qualified", "1.1.0")).toBe(true);
    registry.setAllocation({
      allocationId: "allocation-main", ...key, championVersion: "1.0.0",
      championPercent: 100, challengerPercent: 0, updatedAt: "2026-09-07T08:00:00.000Z"
    });
    expect(registry.activateChallenger({
      allocationId: "allocation-main", ...key, championVersion: "1.0.0", challengerVersion: "1.1.0",
      challengerPermille: 100, activatedAt: "2026-09-07T09:00:00.000Z"
    })).toBe(true);
    expect(registry.compareAndSetStatus(key, "candidate", "replay_qualified", "1.2.0")).toBe(true);
    expect(registry.activateChallenger({
      allocationId: "allocation-main", ...key, championVersion: "1.0.0", challengerVersion: "1.2.0",
      challengerPermille: 100, activatedAt: "2026-09-07T10:00:00.000Z"
    })).toBe(false);
  });

  it("keeps one stable allocation identity for every page fingerprint", () => {
    registry.createVersion(versionFixture("1.0.0", "champion"));
    registry.bindPage(binding("1.0.0", "allocation-main"));
    registry.createVersion(versionFixture("1.1.0", "candidate", "1.0.0"));

    expect(() => registry.bindPage(binding("1.1.0", "allocation-other")))
      .toThrowError("skill_binding_allocation_mismatch");
  });

  it("does not allow one version lifecycle to span multiple page fingerprints", () => {
    registry.createVersion(versionFixture("1.0.0", "champion"));
    registry.bindPage(binding("1.0.0", "allocation-main"));

    expect(() => registry.bindPage({
      ...binding("1.0.0", "allocation-other-page"),
      pageFingerprintHash: "c".repeat(64)
    })).toThrowError("skill_version_page_binding_conflict");
    expect(() => database.prepare(`
      INSERT INTO skill_page_bindings (
        skill_id, version, site, page_fingerprint_hash, allocation_id, active_status, bound_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(
      key.skillId, "1.0.0", key.site, "c".repeat(64), "allocation-other-page",
      "2026-09-07T08:00:00.000Z"
    )).toThrowError("skill_version_page_binding_conflict");
  });

  it("does not allow one allocation identity to span multiple page fingerprints", () => {
    registry.createVersion(versionFixture("1.0.0", "champion"));
    registry.bindPage(binding("1.0.0", "allocation-main"));
    registry.createVersion(versionFixture("1.1.0", "candidate", "1.0.0"));

    expect(() => registry.bindPage({
      ...binding("1.1.0", "allocation-main"),
      pageFingerprintHash: "c".repeat(64)
    })).toThrowError("skill_allocation_scope_mismatch");
    expect(() => database.prepare(`
      INSERT INTO skill_page_bindings (
        skill_id, version, site, page_fingerprint_hash, allocation_id, active_status, bound_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(
      key.skillId, "1.1.0", key.site, "c".repeat(64), "allocation-main",
      "2026-09-07T08:00:00.000Z"
    )).toThrowError("skill_allocation_scope_mismatch");
  });

  it("withdraws challenger traffic when a hard failure quarantines it", () => {
    registry.createVersion(versionFixture("1.0.0", "champion"));
    registry.bindPage(binding("1.0.0", "allocation-main"));
    registry.createVersion(versionFixture("1.1.0", "candidate", "1.0.0"));
    registry.bindPage(binding("1.1.0", "allocation-main"));
    registry.compareAndSetStatus(key, "candidate", "replay_qualified", "1.1.0");
    registry.setAllocation({
      allocationId: "allocation-main",
      ...key,
      championVersion: "1.0.0",
      championPercent: 100,
      challengerPercent: 0,
      updatedAt: "2026-09-07T08:00:00.000Z"
    });
    registry.activateChallenger({
      allocationId: "allocation-main", ...key, championVersion: "1.0.0", challengerVersion: "1.1.0",
      challengerPermille: 100, activatedAt: "2026-09-07T09:00:00.000Z"
    });

    expect(registry.compareAndSetStatus(key, "challenger", "quarantined", "1.1.0")).toBe(true);
    expect(database.prepare(`
      SELECT champion_version, challenger_version, champion_percent, challenger_percent
      FROM skill_traffic_allocations WHERE allocation_id = 'allocation-main'
    `).get()).toEqual({
      champion_version: "1.0.0",
      challenger_version: null,
      champion_percent: 100,
      challenger_percent: 0
    });
  });

  it("atomically restores the previous stable version and gives it all traffic", () => {
    registry.createVersion(versionFixture("1.0.0", "champion"));
    registry.bindPage(binding("1.0.0", "allocation-main"));
    registry.createVersion(versionFixture("1.1.0", "candidate", "1.0.0"));
    registry.bindPage(binding("1.1.0", "allocation-main"));
    registry.compareAndSetStatus(key, "candidate", "replay_qualified", "1.1.0");
    registry.setAllocation({
      allocationId: "allocation-main",
      ...key,
      championVersion: "1.0.0",
      championPercent: 100,
      challengerPercent: 0,
      updatedAt: "2026-09-07T08:00:00.000Z"
    });
    registry.activateChallenger({
      allocationId: "allocation-main", ...key, championVersion: "1.0.0", challengerVersion: "1.1.0",
      challengerPermille: 100, activatedAt: "2026-09-07T09:00:00.000Z"
    });
    expect(registry.compareAndSetStatus(key, "challenger", "champion", "1.1.0")).toBe(true);

    expect(registry.restoreChampion(key, "1.0.0")).toBe(true);
    expect(registry.getVersion(key.skillId, "1.0.0")?.status).toBe("champion");
    expect(registry.getVersion(key.skillId, "1.1.0")?.status).toBe("quarantined");
    expect(database.prepare(`
      SELECT champion_version, challenger_version, champion_percent, challenger_percent
      FROM skill_traffic_allocations WHERE allocation_id = 'allocation-main'
    `).get()).toEqual({
      champion_version: "1.0.0",
      challenger_version: null,
      champion_percent: 100,
      challenger_percent: 0
    });
  });

  it("validates traffic totals and stores a bounded champion/challenger allocation", () => {
    registry.createVersion(versionFixture("1.0.0", "champion"));
    registry.bindPage(binding("1.0.0", "allocation-main"));

    expect(() => registry.setAllocation({
      allocationId: "allocation-main",
      ...key,
      championVersion: "1.0.0",
      championPercent: 90,
      challengerPercent: 0,
      updatedAt: "2026-09-07T08:00:00.000Z"
    })).toThrowError("skill_allocation_total_invalid");

    registry.setAllocation({
      allocationId: "allocation-main",
      ...key,
      championVersion: "1.0.0",
      championPercent: 100,
      challengerPercent: 0,
      updatedAt: "2026-09-07T08:00:00.000Z"
    });
    expect(database.prepare(`
      SELECT champion_percent, challenger_percent FROM skill_traffic_allocations
    `).get()).toEqual({ champion_percent: 100, challenger_percent: 0 });
    expect(registry.getPageAllocation({
      site: key.site,
      pageFingerprintHash: key.pageFingerprintHash
    })).toEqual({
      allocationId: "allocation-main",
      ...key,
      championVersion: "1.0.0",
      championPercent: 100,
      challengerPercent: 0,
      updatedAt: "2026-09-07T08:00:00.000Z"
    });
  });

  it("appends validated audit records and database triggers reject updates and deletes", () => {
    registry.createVersion(versionFixture("1.0.0", "champion"));
    registry.bindPage(binding("1.0.0", "allocation-main"));

    const execution = executionFixture();
    const evaluation = evaluationFixture();
    const evolution: SkillEvolutionRunRecord = {
      runId: "evolution-run-1",
      trigger: "repeated_field_missing",
      inputRecordIds: [execution.recordId],
      candidateSkillId: key.skillId,
      candidateVersion: "1.1.0",
      finalStatus: "candidate",
      payload: { cluster: "field_missing", count: 3 },
      createdAt: "2026-09-07T08:02:00.000Z"
    };
    const sample: SkillReplaySampleRecord = {
      sampleId: "replay-sample-1",
      site: "baidu",
      pageFingerprintHash,
      split: "holdout",
      redactedSnapshot: { controls: [{ semantic: "basics.name", valueType: "string" }] },
      expectedActions: [{ capability: "readback", semantic: "basics.name" }],
      createdAt: "2026-09-07T08:03:00.000Z"
    };
    const replayResult: SkillReplayRunSampleRecord = {
      replayRunId: "replay-run-1",
      sampleId: sample.sampleId,
      skillId: key.skillId,
      version: "1.0.0",
      result: "pass",
      payload: { auditMismatches: 0 },
      createdAt: "2026-09-07T08:04:00.000Z"
    };

    registry.appendExecutionRecord(execution);
    registry.appendExecutionRecord({
      ...execution,
      terminalResult: "failed",
      completedAt: "2026-09-07T08:05:00.000Z"
    });
    const persistedExecution = JSON.parse((database.prepare(
      "SELECT payload_json FROM skill_execution_records WHERE record_id = ?"
    ).get(execution.recordId) as { payload_json: string }).payload_json);
    expect(persistedExecution).toMatchObject({
      terminalResult: "completed_pre_submit",
      completedAt: execution.completedAt
    });
    registry.appendEvaluation(evaluation);
    registry.appendEvolutionRun(evolution);
    registry.appendReplaySample(sample);
    registry.appendReplaySample(sample);
    registry.appendReplayRunSample(replayResult);

    expect(registry.getReplaySample(sample.sampleId)).toEqual(sample);
    expect(registry.listReplaySamplesThrough("2026-09-07T08:03:00.000Z")).toEqual([sample]);
    expect(() => registry.appendReplaySample({
      ...sample,
      expectedActions: [{ capability: "readback", semantic: "basics.email" }]
    })).toThrow("skill_replay_sample_conflict");
    expect(registry.getEvolutionRun(evolution.runId)).toEqual(evolution);

    const appendOnlyTables = [
      ["skill_execution_records", "record_id", execution.recordId],
      ["skill_evaluations", "evaluation_id", evaluation.evaluationId],
      ["skill_evolution_runs", "run_id", evolution.runId],
      ["skill_replay_samples", "sample_id", sample.sampleId],
      ["skill_replay_run_samples", "replay_run_id", replayResult.replayRunId]
    ] as const;
    for (const [table, idColumn, id] of appendOnlyTables) {
      expect(() => database.prepare(`UPDATE ${table} SET created_at = created_at WHERE ${idColumn} = ?`).run(id)).toThrow();
      expect(() => database.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`).run(id)).toThrow();
    }
  });
});

function versionFixture(
  version: string,
  status: ApplicationSkillVersion["status"],
  parentVersion?: string
): ApplicationSkillVersion {
  const content: ApplicationSkillContent = {
    capabilities: ["observe", "fill_empty_fields", "readback", "full_page_audit"],
    pageVariants: [{
      id: "application-form",
      match: {
        routePatterns: [`/jobs/application/${version.replaceAll(".", "-")}`],
        requiredTexts: [`申请职位 ${version}`],
        requiredFields: ["basics.name"]
      },
      workflowEntry: "fill-basics"
    }],
    fields: [{
      semantic: "basics.name",
      controlTypes: ["text"],
      locatorHints: [{ key: "candidate-name", by: "label", text: "姓名" }]
    }],
    workflow: [{
      id: "fill-basics",
      actions: [
        { capability: "fill_empty_fields", semantics: ["basics.name"] },
        { capability: "readback", semantics: ["basics.name"] },
        { capability: "full_page_audit" }
      ],
      success: ["writes_read_back", "audit_clean"],
      next: "continue_or_wait"
    }],
    recovery: { maxRetries: 2, actions: ["reobserve", "refresh-node-ref"] }
  };
  return {
    skillId: key.skillId,
    version,
    ...(parentVersion === undefined ? {} : { parentVersion }),
    schemaVersion: 1,
    contentHash: hashCanonical(content),
    site: "baidu",
    allowedDomains: ["talent.baidu.com"],
    pageFingerprintRule: { ruleId: "baidu-application-form", ruleHash: pageFingerprintRuleHash },
    status,
    content,
    createdBy: { kind: "manual_seed", actorId: "test-suite" },
    createdAt: "2026-09-07T08:00:00.000Z"
  };
}

function binding(version: string, allocationId: string) {
  return {
    skillId: key.skillId,
    version,
    site: key.site,
    pageFingerprintHash,
    allocationId
  } as const;
}

function executionFixture(): SkillExecutionRecord {
  return {
    recordId: "execution-record-1",
    taskId: "application-task-1",
    attemptId: "attempt-1",
    binding: binding("1.0.0", "allocation-main"),
    pageVariantId: "application-form",
    allocation: "champion",
    fieldOutcomes: [{ semantic: "basics.name", outcome: "verified" }],
    counts: { observed: 1, planned: 1, verified: 1, auditMismatches: 0, userCorrections: 0 },
    auditMismatchClasses: [],
    retries: 0,
    recoveries: 0,
    durationMs: 1200,
    terminalResult: "completed_pre_submit",
    startedAt: "2026-09-07T08:00:00.000Z",
    completedAt: "2026-09-07T08:01:00.000Z"
  };
}

function evaluationFixture(): SkillEvaluation {
  return {
    evaluationId: "evaluation-1",
    executionRecordId: "execution-record-1",
    evaluatorVersion: "1.0.0",
    source: "online",
    safetyViolations: 0,
    incorrectWrites: 0,
    fieldAccuracy: 1,
    requiredCompletion: 1,
    userCorrections: 0,
    retries: 0,
    recoveries: 0,
    durationMs: 1200,
    decision: "pass",
    evaluatedAt: "2026-09-07T08:01:30.000Z"
  };
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([property, nested]) => `${JSON.stringify(property)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}
