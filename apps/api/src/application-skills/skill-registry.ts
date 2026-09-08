import { createHash } from "node:crypto";
import {
  ApplicationSkillVersionSchema,
  SkillBindingSchema,
  SkillEvaluationSchema,
  SkillExecutionRecordSchema,
  type ApplicationSkillVersion,
  type SkillBinding,
  type SkillEvaluation,
  type SkillExecutionRecord
} from "@resume/contracts";
import type { SqliteDatabase } from "../db/client.js";
import type { PromotionEngineRegistry, PromotionEvaluationSample } from "./promotion-engine.js";

type SkillStatus = ApplicationSkillVersion["status"];
type SkillSite = ApplicationSkillVersion["site"];

export interface SkillPageKey {
  readonly skillId: string;
  readonly site: SkillSite;
  readonly pageFingerprintHash: string;
}

export interface SkillTrafficAllocationInput extends SkillPageKey {
  readonly allocationId: string;
  readonly championVersion: string;
  readonly challengerVersion?: string;
  readonly championPercent: number;
  readonly challengerPercent: number;
  readonly updatedAt: string;
}

export interface SkillChallengerActivationInput extends SkillPageKey {
  readonly allocationId: string;
  readonly championVersion: string;
  readonly challengerVersion: string;
  readonly challengerPermille: number;
  readonly activatedAt: string;
}

export interface SkillEvolutionRunRecord {
  readonly runId: string;
  readonly trigger: string;
  readonly inputRecordIds: readonly string[];
  readonly candidateSkillId?: string;
  readonly candidateVersion?: string;
  readonly finalStatus: SkillStatus;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface SkillReplaySampleRecord {
  readonly sampleId: string;
  readonly site: SkillSite;
  readonly pageFingerprintHash: string;
  readonly split: "train" | "holdout";
  readonly redactedSnapshot: unknown;
  readonly expectedActions: unknown;
  readonly createdAt: string;
}

export interface SkillReplayRunSampleRecord {
  readonly replayRunId: string;
  readonly sampleId: string;
  readonly skillId: string;
  readonly version: string;
  readonly result: "pass" | "fail" | "equal";
  readonly payload: unknown;
  readonly createdAt: string;
}

interface SkillVersionRow {
  skill_id: string;
  version: string;
  parent_version: string | null;
  schema_version: number;
  content_hash: string;
  site: SkillSite;
  allowed_domains_json: string;
  page_fingerprint_rule_json: string;
  status: SkillStatus;
  content_json: string;
  created_by_json: string;
  created_at: string;
}

interface BoundVersionRow {
  skill_id: string;
  version: string;
  status: SkillStatus;
  allocation_id: string;
  active_status: "challenger" | "champion" | null;
}

interface SkillTrafficAllocationRow {
  allocation_id: string;
  skill_id: string;
  site: SkillSite;
  page_fingerprint_hash: string;
  champion_version: string;
  challenger_version: string | null;
  champion_percent: number;
  challenger_percent: number;
  updated_at: string;
}

interface SkillReplaySampleRow {
  sample_id: string;
  site: SkillSite;
  page_fingerprint_hash: string;
  split: "train" | "holdout";
  redacted_snapshot_json: string;
  expected_actions_json: string;
  created_at: string;
}

interface SkillEvolutionRunRow {
  run_id: string;
  trigger: string;
  input_record_ids_json: string;
  candidate_skill_id: string | null;
  candidate_version: string | null;
  final_status: SkillStatus;
  payload_json: string;
  created_at: string;
}

const SKILL_ID = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const HASH = /^[a-f0-9]{64}$/u;
const RUNTIME_ID = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const STATUS = new Set<SkillStatus>([
  "candidate",
  "replay_qualified",
  "challenger",
  "champion",
  "retired",
  "quarantined"
]);

const NEXT_STATUS: Partial<Record<SkillStatus, SkillStatus>> = {
  candidate: "replay_qualified",
  replay_qualified: "challenger",
  challenger: "champion",
  champion: "retired"
};

export class SkillRegistry implements PromotionEngineRegistry {
  public constructor(private readonly database: SqliteDatabase) {}

  public createVersion(input: ApplicationSkillVersion): { created: boolean; version: string } {
    const version = ApplicationSkillVersionSchema.parse(input);
    if (version.status !== "candidate" && version.status !== "champion") {
      throw new Error("skill_initial_status_invalid");
    }
    const contentHash = canonicalSkillContentHash(version.content);
    if (contentHash !== version.contentHash) throw new Error("skill_content_hash_mismatch");

    const existingContent = this.database.prepare(`
      SELECT skill_id, version FROM skill_versions WHERE content_hash = ?
    `).get(contentHash) as { skill_id: string; version: string } | undefined;
    if (existingContent !== undefined) {
      return { created: false, version: existingContent.version };
    }

    const existingVersion = this.database.prepare(`
      SELECT content_hash FROM skill_versions WHERE skill_id = ? AND version = ?
    `).get(version.skillId, version.version) as { content_hash: string } | undefined;
    if (existingVersion !== undefined) throw new Error("skill_version_conflict");

    if (version.parentVersion !== undefined) {
      const parent = this.database.prepare(`
        SELECT 1 FROM skill_versions WHERE skill_id = ? AND version = ?
      `).get(version.skillId, version.parentVersion);
      if (parent === undefined) throw new Error("skill_parent_version_not_found");
    }

    this.database.prepare(`
      INSERT INTO skill_versions (
        skill_id, version, parent_version, schema_version, content_hash, site,
        allowed_domains_json, page_fingerprint_rule_json, status, content_json,
        created_by_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      version.skillId,
      version.version,
      version.parentVersion ?? null,
      version.schemaVersion,
      version.contentHash,
      version.site,
      canonicalJson(version.allowedDomains),
      canonicalJson(version.pageFingerprintRule),
      version.status,
      canonicalJson(version.content),
      canonicalJson(version.createdBy),
      version.createdAt
    );

    return { created: true, version: version.version };
  }

  public getVersion(skillId: string, version: string): ApplicationSkillVersion | undefined {
    const row = this.database.prepare(`
      SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?
    `).get(skillId, version) as SkillVersionRow | undefined;
    return row === undefined ? undefined : versionFromRow(row);
  }

  public getChampionForSite(site: SkillSite): ApplicationSkillVersion | undefined {
    validateSite(site);
    const rows = this.database.prepare(`
      SELECT * FROM skill_versions
      WHERE site = ? AND status = 'champion'
      ORDER BY skill_id ASC, version DESC
      LIMIT 2
    `).all(site) as SkillVersionRow[];
    return rows.length === 1 ? versionFromRow(rows[0]!) : undefined;
  }

  public getPageAllocation(input: {
    site: SkillSite;
    pageFingerprintHash: string;
  }): SkillTrafficAllocationInput | undefined {
    validateSite(input.site);
    validateHash(input.pageFingerprintHash);
    const row = this.database.prepare(`
      SELECT allocation_id, skill_id, site, page_fingerprint_hash,
             champion_version, challenger_version, champion_percent,
             challenger_percent, updated_at
      FROM skill_traffic_allocations
      WHERE site = ? AND page_fingerprint_hash = ?
      ORDER BY updated_at DESC, allocation_id ASC
      LIMIT 1
    `).get(input.site, input.pageFingerprintHash) as SkillTrafficAllocationRow | undefined;
    if (row === undefined) return undefined;
    return {
      allocationId: row.allocation_id,
      skillId: row.skill_id,
      site: row.site,
      pageFingerprintHash: row.page_fingerprint_hash,
      championVersion: row.champion_version,
      ...(row.challenger_version === null ? {} : { challengerVersion: row.challenger_version }),
      championPercent: row.champion_percent,
      challengerPercent: row.challenger_percent,
      updatedAt: row.updated_at
    };
  }

  public bindPage(input: SkillBinding): void {
    const binding = SkillBindingSchema.parse(input);
    const version = this.getVersion(binding.skillId, binding.version);
    if (version === undefined) throw new Error("skill_version_not_found");
    if (version.site !== binding.site) throw new Error("skill_binding_site_mismatch");

    const existing = this.database.prepare(`
      SELECT allocation_id FROM skill_page_bindings
      WHERE skill_id = ? AND version = ? AND site = ? AND page_fingerprint_hash = ?
    `).get(
      binding.skillId,
      binding.version,
      binding.site,
      binding.pageFingerprintHash
    ) as { allocation_id: string } | undefined;
    if (existing !== undefined) {
      if (existing.allocation_id !== binding.allocationId) throw new Error("skill_binding_conflict");
      return;
    }

    const versionScope = this.database.prepare(`
      SELECT site, page_fingerprint_hash FROM skill_page_bindings
      WHERE skill_id = ? AND version = ?
      LIMIT 1
    `).get(binding.skillId, binding.version) as {
      site: SkillSite;
      page_fingerprint_hash: string;
    } | undefined;
    if (versionScope !== undefined && (
      versionScope.site !== binding.site
      || versionScope.page_fingerprint_hash !== binding.pageFingerprintHash
    )) {
      throw new Error("skill_version_page_binding_conflict");
    }

    const allocationScope = this.database.prepare(`
      SELECT site, page_fingerprint_hash FROM skill_page_bindings
      WHERE allocation_id = ?
      LIMIT 1
    `).get(binding.allocationId) as {
      site: SkillSite;
      page_fingerprint_hash: string;
    } | undefined;
    if (allocationScope !== undefined && (
      allocationScope.site !== binding.site
      || allocationScope.page_fingerprint_hash !== binding.pageFingerprintHash
    )) {
      throw new Error("skill_allocation_scope_mismatch");
    }

    const pageAllocation = this.database.prepare(`
      SELECT allocation_id FROM skill_page_bindings
      WHERE site = ? AND page_fingerprint_hash = ?
      LIMIT 1
    `).get(binding.site, binding.pageFingerprintHash) as { allocation_id: string } | undefined;
    if (pageAllocation !== undefined && pageAllocation.allocation_id !== binding.allocationId) {
      throw new Error("skill_binding_allocation_mismatch");
    }

    this.database.prepare(`
      INSERT INTO skill_page_bindings (
        skill_id, version, site, page_fingerprint_hash, allocation_id, active_status, bound_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      binding.skillId,
      binding.version,
      binding.site,
      binding.pageFingerprintHash,
      binding.allocationId,
      activeStatus(version.status),
      new Date().toISOString()
    );
  }

  public setAllocation(input: SkillTrafficAllocationInput): void {
    validatePageKey(input);
    validateRuntimeId(input.allocationId, "skill_allocation_id_invalid");
    validateVersion(input.championVersion);
    if (input.challengerVersion !== undefined) validateVersion(input.challengerVersion);
    validateTimestamp(input.updatedAt, "skill_allocation_timestamp_invalid");
    validatePercent(input.championPercent);
    validatePercent(input.challengerPercent);
    if (input.championPercent + input.challengerPercent !== 100) {
      throw new Error("skill_allocation_total_invalid");
    }
    if ((input.challengerVersion === undefined) !== (input.challengerPercent === 0)) {
      throw new Error("skill_challenger_allocation_invalid");
    }

    this.requireActiveBinding(input, input.championVersion, "champion", input.allocationId);
    if (input.challengerVersion !== undefined) {
      this.requireActiveBinding(input, input.challengerVersion, "challenger", input.allocationId);
    }

    this.database.prepare(`
      INSERT INTO skill_traffic_allocations (
        allocation_id, skill_id, site, page_fingerprint_hash, champion_version,
        challenger_version, champion_percent, challenger_percent, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(allocation_id) DO UPDATE SET
        champion_version = excluded.champion_version,
        challenger_version = excluded.challenger_version,
        champion_percent = excluded.champion_percent,
        challenger_percent = excluded.challenger_percent,
        updated_at = excluded.updated_at
    `).run(
      input.allocationId,
      input.skillId,
      input.site,
      input.pageFingerprintHash,
      input.championVersion,
      input.challengerVersion ?? null,
      input.championPercent,
      input.challengerPercent,
      input.updatedAt
    );
  }

  public compareAndSetStatus(
    key: SkillPageKey,
    expected: SkillStatus,
    next: SkillStatus,
    version: string
  ): boolean {
    validatePageKey(key);
    validateVersion(version);
    validateStatus(expected);
    validateStatus(next);
    if (expected === "replay_qualified" && next === "challenger") return false;
    const hardFailureTransition = next === "quarantined"
      && expected !== "retired"
      && expected !== "quarantined";
    if (NEXT_STATUS[expected] !== next && !hardFailureTransition) return false;

    const transition = this.database.transaction(() => {
      const target = this.findBoundVersion(key, version);
      if (target === undefined || target.status !== expected) return false;

      if (expected === "challenger" && next === "champion") {
        const currentChampion = this.findActiveBinding(key, "champion");
        if (currentChampion !== undefined && currentChampion.version !== version) {
          const retired = this.database.prepare(`
            UPDATE skill_versions SET status = 'retired'
            WHERE skill_id = ? AND version = ? AND status = 'champion'
          `).run(currentChampion.skill_id, currentChampion.version);
          if (retired.changes !== 1) return false;
          this.database.prepare(`
            UPDATE skill_page_bindings SET active_status = NULL
            WHERE skill_id = ? AND version = ? AND site = ? AND page_fingerprint_hash = ?
          `).run(currentChampion.skill_id, currentChampion.version, key.site, key.pageFingerprintHash);
        }
      }

      const updated = this.database.prepare(`
        UPDATE skill_versions SET status = ?
        WHERE skill_id = ? AND version = ? AND status = ?
      `).run(next, key.skillId, version, expected);
      if (updated.changes !== 1) return false;

      this.database.prepare(`
        UPDATE skill_page_bindings SET active_status = ?
        WHERE skill_id = ? AND version = ? AND site = ? AND page_fingerprint_hash = ?
      `).run(activeStatus(next), key.skillId, version, key.site, key.pageFingerprintHash);

      if (next === "quarantined" && expected === "challenger") {
        this.database.prepare(`
          UPDATE skill_traffic_allocations
          SET challenger_version = NULL, challenger_percent = 0,
              champion_percent = 100, updated_at = ?
          WHERE skill_id = ? AND site = ? AND page_fingerprint_hash = ?
            AND challenger_version = ?
        `).run(new Date().toISOString(), key.skillId, key.site, key.pageFingerprintHash, version);
      }
      if (next === "quarantined" && expected === "champion") {
        this.database.prepare(`
          DELETE FROM skill_traffic_allocations
          WHERE skill_id = ? AND site = ? AND page_fingerprint_hash = ?
            AND champion_version = ?
        `).run(key.skillId, key.site, key.pageFingerprintHash, version);
      }

      if (next === "champion") {
        this.database.prepare(`
          UPDATE skill_traffic_allocations
          SET champion_version = ?, challenger_version = NULL,
              champion_percent = 100, challenger_percent = 0,
              updated_at = ?
          WHERE skill_id = ? AND site = ? AND page_fingerprint_hash = ?
        `).run(version, new Date().toISOString(), key.skillId, key.site, key.pageFingerprintHash);
      }
      return true;
    });

    return transition.immediate();
  }

  public activateChallenger(input: SkillChallengerActivationInput): boolean {
    validatePageKey(input);
    validateRuntimeId(input.allocationId, "skill_allocation_id_invalid");
    validateVersion(input.championVersion);
    validateVersion(input.challengerVersion);
    validateTimestamp(input.activatedAt, "skill_allocation_timestamp_invalid");
    if (input.challengerPermille !== 100) throw new Error("skill_challenger_allocation_invalid");

    const activate = this.database.transaction(() => {
      const champion = this.findBoundVersion(input, input.championVersion);
      const challenger = this.findBoundVersion(input, input.challengerVersion);
      if (champion?.status !== "champion"
        || champion.active_status !== "champion"
        || champion.allocation_id !== input.allocationId
        || challenger?.status !== "replay_qualified"
        || challenger.allocation_id !== input.allocationId) return false;
      const allocation = this.database.prepare(`
        SELECT champion_version, challenger_version, champion_percent, challenger_percent
        FROM skill_traffic_allocations
        WHERE allocation_id = ? AND skill_id = ? AND site = ? AND page_fingerprint_hash = ?
      `).get(
        input.allocationId,
        input.skillId,
        input.site,
        input.pageFingerprintHash
      ) as {
        champion_version: string;
        challenger_version: string | null;
        champion_percent: number;
        challenger_percent: number;
      } | undefined;
      if (allocation === undefined
        || allocation.champion_version !== input.championVersion
        || allocation.challenger_version !== null
        || allocation.champion_percent !== 100
        || allocation.challenger_percent !== 0) return false;

      const promoted = this.database.prepare(`
        UPDATE skill_versions SET status = 'challenger'
        WHERE skill_id = ? AND version = ? AND status = 'replay_qualified'
      `).run(input.skillId, input.challengerVersion);
      if (promoted.changes !== 1) throw new Error("skill_challenger_activation_conflict");
      this.database.prepare(`
        UPDATE skill_page_bindings SET active_status = 'challenger'
        WHERE skill_id = ? AND version = ? AND site = ? AND page_fingerprint_hash = ?
      `).run(input.skillId, input.challengerVersion, input.site, input.pageFingerprintHash);
      const allocated = this.database.prepare(`
        UPDATE skill_traffic_allocations
        SET challenger_version = ?, champion_percent = 90, challenger_percent = 10, updated_at = ?
        WHERE allocation_id = ? AND champion_version = ?
          AND challenger_version IS NULL AND champion_percent = 100 AND challenger_percent = 0
      `).run(input.challengerVersion, input.activatedAt, input.allocationId, input.championVersion);
      if (allocated.changes !== 1) throw new Error("skill_challenger_activation_conflict");
      return true;
    });
    return activate.immediate();
  }

  public retireChallenger(input: {
    skillId: string;
    site: SkillSite;
    pageFingerprintHash: string;
    allocationId: string;
    championVersion: string;
    challengerVersion: string;
    retiredAt: string;
  }): boolean {
    validatePageKey(input);
    validateRuntimeId(input.allocationId, "skill_allocation_id_invalid");
    validateVersion(input.championVersion);
    validateVersion(input.challengerVersion);
    validateTimestamp(input.retiredAt, "skill_allocation_timestamp_invalid");
    const retire = this.database.transaction(() => {
      const champion = this.findBoundVersion(input, input.championVersion);
      const challenger = this.findBoundVersion(input, input.challengerVersion);
      if (champion?.status !== "champion" || champion.active_status !== "champion"
        || challenger?.status !== "challenger" || challenger.active_status !== "challenger"
        || champion.allocation_id !== input.allocationId || challenger.allocation_id !== input.allocationId) return false;
      const allocation = this.getPageAllocation(input);
      if (allocation?.allocationId !== input.allocationId
        || allocation.championVersion !== input.championVersion
        || allocation.challengerVersion !== input.challengerVersion) return false;
      const updated = this.database.prepare(`
        UPDATE skill_versions SET status = 'retired'
        WHERE skill_id = ? AND version = ? AND status = 'challenger'
      `).run(input.skillId, input.challengerVersion);
      if (updated.changes !== 1) throw new Error("skill_challenger_retirement_conflict");
      this.database.prepare(`
        UPDATE skill_page_bindings SET active_status = NULL
        WHERE skill_id = ? AND version = ? AND site = ? AND page_fingerprint_hash = ?
      `).run(input.skillId, input.challengerVersion, input.site, input.pageFingerprintHash);
      const allocated = this.database.prepare(`
        UPDATE skill_traffic_allocations
        SET challenger_version = NULL, champion_percent = 100, challenger_percent = 0, updated_at = ?
        WHERE allocation_id = ? AND challenger_version = ?
      `).run(input.retiredAt, input.allocationId, input.challengerVersion);
      if (allocated.changes !== 1) throw new Error("skill_challenger_retirement_conflict");
      return true;
    });
    return retire.immediate();
  }

  public restoreChampion(key: SkillPageKey, stableVersion: string): boolean {
    validatePageKey(key);
    validateVersion(stableVersion);

    const restore = this.database.transaction(() => {
      const stable = this.findBoundVersion(key, stableVersion);
      if (stable === undefined || (stable.status !== "retired" && stable.status !== "champion")) return false;

      const failedChampion = this.findActiveBinding(key, "champion");
      if (failedChampion !== undefined && failedChampion.version !== stableVersion) {
        const quarantined = this.database.prepare(`
          UPDATE skill_versions SET status = 'quarantined'
          WHERE skill_id = ? AND version = ? AND status = 'champion'
        `).run(failedChampion.skill_id, failedChampion.version);
        if (quarantined.changes !== 1) return false;
        this.database.prepare(`
          UPDATE skill_page_bindings SET active_status = NULL
          WHERE skill_id = ? AND version = ? AND site = ? AND page_fingerprint_hash = ?
        `).run(failedChampion.skill_id, failedChampion.version, key.site, key.pageFingerprintHash);
      }

      this.database.prepare(`
        UPDATE skill_page_bindings SET active_status = NULL
        WHERE site = ? AND page_fingerprint_hash = ? AND active_status = 'challenger'
      `).run(key.site, key.pageFingerprintHash);

      if (stable.status === "retired") {
        const promoted = this.database.prepare(`
          UPDATE skill_versions SET status = 'champion'
          WHERE skill_id = ? AND version = ? AND status = 'retired'
        `).run(key.skillId, stableVersion);
        if (promoted.changes !== 1) return false;
      }
      this.database.prepare(`
        UPDATE skill_page_bindings SET active_status = 'champion'
        WHERE skill_id = ? AND version = ? AND site = ? AND page_fingerprint_hash = ?
      `).run(key.skillId, stableVersion, key.site, key.pageFingerprintHash);

      const allocationId = stable.allocation_id;
      this.database.prepare(`
        INSERT INTO skill_traffic_allocations (
          allocation_id, skill_id, site, page_fingerprint_hash, champion_version,
          challenger_version, champion_percent, challenger_percent, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 100, 0, ?)
        ON CONFLICT(allocation_id) DO UPDATE SET
          champion_version = excluded.champion_version,
          challenger_version = NULL,
          champion_percent = 100,
          challenger_percent = 0,
          updated_at = excluded.updated_at
      `).run(
        allocationId,
        key.skillId,
        key.site,
        key.pageFingerprintHash,
        stableVersion,
        new Date().toISOString()
      );
      return true;
    });

    return restore.immediate();
  }

  public appendExecutionRecord(input: SkillExecutionRecord): boolean {
    const record = SkillExecutionRecordSchema.parse(input);
    this.requireBinding(record.binding);
    const inserted = this.database.prepare(`
      INSERT INTO skill_execution_records (
        record_id, skill_id, version, site, page_fingerprint_hash,
        payload_json, started_at, completed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO NOTHING
    `).run(
      record.recordId,
      record.binding.skillId,
      record.binding.version,
      record.binding.site,
      record.binding.pageFingerprintHash,
      canonicalJson(record),
      record.startedAt,
      record.completedAt,
      record.completedAt
    );
    return inserted.changes === 1;
  }

  public appendEvaluation(input: SkillEvaluation): boolean {
    const evaluation = SkillEvaluationSchema.parse(input);
    const existing = this.database.prepare(`
      SELECT payload_json FROM skill_evaluations WHERE evaluation_id = ?
    `).get(evaluation.evaluationId) as { payload_json: string } | undefined;
    if (existing !== undefined) {
      if (canonicalJson(parseJson(existing.payload_json)) !== canonicalJson(evaluation)) {
        throw new Error("skill_evaluation_conflict");
      }
      return false;
    }
    this.database.prepare(`
      INSERT INTO skill_evaluations (
        evaluation_id, execution_record_id, payload_json, evaluated_at, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      evaluation.evaluationId,
      evaluation.executionRecordId,
      canonicalJson(evaluation),
      evaluation.evaluatedAt,
      evaluation.evaluatedAt
    );
    return true;
  }

  public appendPromotionEvaluation(sample: PromotionEvaluationSample): boolean {
    const record = SkillExecutionRecordSchema.parse(sample.record);
    const evaluation = SkillEvaluationSchema.parse(sample.evaluation);
    if (evaluation.executionRecordId !== record.recordId
      || sample.requiredFieldCount !== record.counts.planned
      || sample.newAuditMismatches !== record.counts.auditMismatches) {
      throw new Error("skill_promotion_sample_invalid");
    }
    return this.appendEvaluation(evaluation);
  }

  public listPromotionEvaluations(allocationId: string): PromotionEvaluationSample[] {
    validateRuntimeId(allocationId, "skill_allocation_id_invalid");
    const rows = this.database.prepare(`
      SELECT r.payload_json AS record_json, e.payload_json AS evaluation_json
      FROM skill_execution_records r
      JOIN skill_evaluations e ON e.execution_record_id = r.record_id
      ORDER BY r.record_id ASC, e.evaluation_id ASC
    `).all() as Array<{ record_json: string; evaluation_json: string }>;
    return rows.flatMap((row) => {
      const record = SkillExecutionRecordSchema.parse(parseJson(row.record_json));
      if (record.binding.allocationId !== allocationId) return [];
      return [{
        record,
        evaluation: SkillEvaluationSchema.parse(parseJson(row.evaluation_json)),
        scenarioClass: record.pageVariantId,
        requiredFieldCount: record.counts.planned,
        newAuditMismatches: record.counts.auditMismatches
      }];
    });
  }

  public appendEvolutionRun(input: SkillEvolutionRunRecord): void {
    validateRuntimeId(input.runId, "skill_evolution_run_id_invalid");
    validateNonEmpty(input.trigger, "skill_evolution_trigger_invalid");
    input.inputRecordIds.forEach((id) => validateRuntimeId(id, "skill_evolution_input_id_invalid"));
    validateStatus(input.finalStatus);
    validateTimestamp(input.createdAt, "skill_evolution_timestamp_invalid");
    if ((input.candidateSkillId === undefined) !== (input.candidateVersion === undefined)) {
      throw new Error("skill_evolution_candidate_invalid");
    }
    if (input.candidateSkillId !== undefined) {
      validateSkillId(input.candidateSkillId);
      validateVersion(input.candidateVersion!);
    }
    this.database.prepare(`
      INSERT INTO skill_evolution_runs (
        run_id, trigger, input_record_ids_json, candidate_skill_id,
        candidate_version, final_status, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.trigger,
      canonicalJson(input.inputRecordIds),
      input.candidateSkillId ?? null,
      input.candidateVersion ?? null,
      input.finalStatus,
      canonicalJson(input.payload),
      input.createdAt
    );
  }

  public getEvolutionRun(runId: string): SkillEvolutionRunRecord | undefined {
    validateRuntimeId(runId, "skill_evolution_run_id_invalid");
    const row = this.database.prepare(`
      SELECT run_id, trigger, input_record_ids_json, candidate_skill_id,
        candidate_version, final_status, payload_json, created_at
      FROM skill_evolution_runs
      WHERE run_id = ?
    `).get(runId) as SkillEvolutionRunRow | undefined;
    if (row === undefined) return undefined;
    return {
      runId: row.run_id,
      trigger: row.trigger,
      inputRecordIds: parseJson<string[]>(row.input_record_ids_json),
      ...(row.candidate_skill_id === null ? {} : {
        candidateSkillId: row.candidate_skill_id,
        candidateVersion: row.candidate_version!
      }),
      finalStatus: row.final_status,
      payload: parseJson(row.payload_json),
      createdAt: row.created_at
    };
  }

  public appendReplaySample(input: SkillReplaySampleRecord): void {
    validateRuntimeId(input.sampleId, "skill_replay_sample_id_invalid");
    validateSite(input.site);
    validateHash(input.pageFingerprintHash);
    validateTimestamp(input.createdAt, "skill_replay_sample_timestamp_invalid");
    const normalized: SkillReplaySampleRecord = {
      sampleId: input.sampleId,
      site: input.site,
      pageFingerprintHash: input.pageFingerprintHash,
      split: input.split,
      redactedSnapshot: input.redactedSnapshot,
      expectedActions: input.expectedActions,
      createdAt: input.createdAt
    };
    const existing = this.getReplaySample(input.sampleId);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(normalized)) {
        throw new Error("skill_replay_sample_conflict");
      }
      return;
    }
    this.database.prepare(`
      INSERT INTO skill_replay_samples (
        sample_id, site, page_fingerprint_hash, split,
        redacted_snapshot_json, expected_actions_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sampleId,
      input.site,
      input.pageFingerprintHash,
      input.split,
      canonicalJson(input.redactedSnapshot),
      canonicalJson(input.expectedActions),
      input.createdAt
    );
  }

  public getReplaySample(sampleId: string): SkillReplaySampleRecord | undefined {
    validateRuntimeId(sampleId, "skill_replay_sample_id_invalid");
    const row = this.database.prepare(`
      SELECT sample_id, site, page_fingerprint_hash, split,
        redacted_snapshot_json, expected_actions_json, created_at
      FROM skill_replay_samples
      WHERE sample_id = ?
    `).get(sampleId) as SkillReplaySampleRow | undefined;
    return row === undefined ? undefined : replaySampleFromRow(row);
  }

  public listReplaySamplesThrough(cutoffAt: string): SkillReplaySampleRecord[] {
    validateTimestamp(cutoffAt, "skill_replay_cutoff_timestamp_invalid");
    return (this.database.prepare(`
      SELECT sample_id, site, page_fingerprint_hash, split,
        redacted_snapshot_json, expected_actions_json, created_at
      FROM skill_replay_samples
      WHERE created_at <= ?
      ORDER BY created_at ASC, sample_id ASC
    `).all(cutoffAt) as SkillReplaySampleRow[]).map(replaySampleFromRow);
  }

  public listReplaySamples(): SkillReplaySampleRecord[] {
    return (this.database.prepare(`
      SELECT sample_id, site, page_fingerprint_hash, split,
        redacted_snapshot_json, expected_actions_json, created_at
      FROM skill_replay_samples
      ORDER BY created_at ASC, sample_id ASC
    `).all() as SkillReplaySampleRow[]).map(replaySampleFromRow);
  }

  public appendReplayRunSample(input: SkillReplayRunSampleRecord): void {
    validateRuntimeId(input.replayRunId, "skill_replay_run_id_invalid");
    validateRuntimeId(input.sampleId, "skill_replay_sample_id_invalid");
    validateSkillId(input.skillId);
    validateVersion(input.version);
    validateTimestamp(input.createdAt, "skill_replay_run_timestamp_invalid");
    this.database.prepare(`
      INSERT INTO skill_replay_run_samples (
        replay_run_id, sample_id, skill_id, version, result, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.replayRunId,
      input.sampleId,
      input.skillId,
      input.version,
      input.result,
      canonicalJson(input.payload),
      input.createdAt
    );
  }

  private findBoundVersion(key: SkillPageKey, version: string): BoundVersionRow | undefined {
    return this.database.prepare(`
      SELECT v.skill_id, v.version, v.status, b.allocation_id, b.active_status
      FROM skill_versions v
      JOIN skill_page_bindings b ON b.skill_id = v.skill_id AND b.version = v.version
      WHERE v.skill_id = ? AND v.version = ? AND b.site = ? AND b.page_fingerprint_hash = ?
    `).get(key.skillId, version, key.site, key.pageFingerprintHash) as BoundVersionRow | undefined;
  }

  private findActiveBinding(
    key: SkillPageKey,
    status: "challenger" | "champion"
  ): BoundVersionRow | undefined {
    return this.database.prepare(`
      SELECT v.skill_id, v.version, v.status, b.allocation_id, b.active_status
      FROM skill_page_bindings b
      JOIN skill_versions v ON v.skill_id = b.skill_id AND v.version = b.version
      WHERE b.site = ? AND b.page_fingerprint_hash = ? AND b.active_status = ?
    `).get(key.site, key.pageFingerprintHash, status) as BoundVersionRow | undefined;
  }

  private requireActiveBinding(
    key: SkillPageKey,
    version: string,
    status: "challenger" | "champion",
    allocationId: string
  ): void {
    const binding = this.findBoundVersion(key, version);
    if (binding === undefined || binding.active_status !== status || binding.status !== status) {
      throw new Error(`skill_${status}_binding_not_found`);
    }
    if (binding.allocation_id !== allocationId) throw new Error("skill_allocation_binding_mismatch");
  }

  private requireBinding(binding: SkillBinding): void {
    const row = this.database.prepare(`
      SELECT allocation_id FROM skill_page_bindings
      WHERE skill_id = ? AND version = ? AND site = ? AND page_fingerprint_hash = ?
    `).get(
      binding.skillId,
      binding.version,
      binding.site,
      binding.pageFingerprintHash
    ) as { allocation_id: string } | undefined;
    if (row === undefined || row.allocation_id !== binding.allocationId) {
      throw new Error("skill_execution_binding_not_found");
    }
  }
}

export function canonicalSkillContentHash(content: ApplicationSkillVersion["content"]): string {
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
}

function versionFromRow(row: SkillVersionRow): ApplicationSkillVersion {
  return ApplicationSkillVersionSchema.parse({
    skillId: row.skill_id,
    version: row.version,
    ...(row.parent_version === null ? {} : { parentVersion: row.parent_version }),
    schemaVersion: row.schema_version,
    contentHash: row.content_hash,
    site: row.site,
    allowedDomains: JSON.parse(row.allowed_domains_json),
    pageFingerprintRule: JSON.parse(row.page_fingerprint_rule_json),
    status: row.status,
    content: JSON.parse(row.content_json),
    createdBy: JSON.parse(row.created_by_json),
    createdAt: row.created_at
  });
}

function replaySampleFromRow(row: SkillReplaySampleRow): SkillReplaySampleRecord {
  return {
    sampleId: row.sample_id,
    site: row.site,
    pageFingerprintHash: row.page_fingerprint_hash,
    split: row.split,
    redactedSnapshot: parseJson(row.redacted_snapshot_json),
    expectedActions: parseJson(row.expected_actions_json),
    createdAt: row.created_at
  };
}

function parseJson<T = unknown>(value: string): T {
  return JSON.parse(value) as T;
}

function activeStatus(status: SkillStatus): "challenger" | "champion" | null {
  return status === "challenger" || status === "champion" ? status : null;
}

function validatePageKey(key: SkillPageKey): void {
  validateSkillId(key.skillId);
  validateSite(key.site);
  validateHash(key.pageFingerprintHash);
}

function validateSkillId(value: string): void {
  if (value.length > 128 || !SKILL_ID.test(value)) throw new Error("skill_id_invalid");
}

function validateRuntimeId(value: string, code: string): void {
  if (value.length > 128 || !RUNTIME_ID.test(value)) throw new Error(code);
}

function validateVersion(value: string): void {
  if (value.length > 64 || !VERSION.test(value)) throw new Error("skill_version_invalid");
}

function validateHash(value: string): void {
  if (!HASH.test(value)) throw new Error("skill_page_fingerprint_hash_invalid");
}

function validateSite(value: string): asserts value is SkillSite {
  if (value !== "baidu" && value !== "moka" && value !== "dji") throw new Error("skill_site_invalid");
}

function validateStatus(value: string): asserts value is SkillStatus {
  if (!STATUS.has(value as SkillStatus)) throw new Error("skill_status_invalid");
}

function validatePercent(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("skill_allocation_percent_invalid");
}

function validateTimestamp(value: string, code: string): void {
  if (Number.isNaN(Date.parse(value))) throw new Error(code);
}

function validateNonEmpty(value: string, code: string): void {
  if (value.trim().length === 0 || value.length > 128) throw new Error(code);
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("skill_json_value_invalid");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("skill_json_value_invalid");
  if (seen.has(value)) throw new Error("skill_json_value_circular");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, seen)).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((property) => `${JSON.stringify(property)}:${canonicalJson(record[property], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}
