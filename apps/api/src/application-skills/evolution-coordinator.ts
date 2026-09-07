import { createHash } from "node:crypto";
import {
  ApplicationSkillVersionSchema,
  SkillEvaluationSchema,
  type ApplicationSkillVersion,
  type SkillBinding,
  type SkillEvaluation
} from "@resume/contracts";
import {
  SKILL_EVALUATOR_VERSION,
  aggregateEvaluations,
  compareEvaluation,
  type AggregatedSkillEvaluation
} from "./evaluation-engine.js";
import type { SkillEvolutionAgent } from "./evolution-agent.js";
import type { EvolutionOpportunity } from "./evolution-collector.js";
import type {
  EvaluatorHoldoutSnapshot,
  EvolutionTrainingSnapshot,
  RedactedReplaySample
} from "./replay-corpus.js";
import type {
  SkillEvolutionRunRecord,
  SkillPageKey,
  SkillTrafficAllocationInput
} from "./skill-registry.js";
import { canonicalSkillContentHash } from "./skill-registry.js";
import { validateSkillCandidate } from "./skill-validator.js";

const REQUIRED_SYNTHETIC_SCENARIOS = [
  "reordered-controls",
  "duplicate-label",
  "delayed-options",
  "hidden-honeypot",
  "unexpected-navigation",
  "stale-node",
  "post-fill-mutation"
] as const;

type GateName = "schema" | "semantics" | "safety-simulation" | "hidden-holdout-replay" | "synthetic-ats";
type RejectionGate = GateName | "generation" | "registry";

export interface EvolutionCoordinatorRegistry {
  createVersion(input: ApplicationSkillVersion): { created: boolean; version: string };
  getVersion(skillId: string, version: string): ApplicationSkillVersion | undefined;
  bindPage(input: SkillBinding): void;
  getPageAllocation(input: { site: ApplicationSkillVersion["site"]; pageFingerprintHash: string }):
    SkillTrafficAllocationInput | undefined;
  compareAndSetStatus(
    key: SkillPageKey,
    expected: ApplicationSkillVersion["status"],
    next: ApplicationSkillVersion["status"],
    version: string
  ): boolean;
  appendEvolutionRun(input: SkillEvolutionRunRecord): void;
  getEvolutionRun(runId: string): SkillEvolutionRunRecord | undefined;
}

export interface ReplayEvaluationResult {
  readonly sampleId: string;
  readonly evaluation: SkillEvaluation;
}

export interface OfflineReplayRunner {
  evaluate(input: {
    readonly skill: ApplicationSkillVersion;
    readonly samples: readonly RedactedReplaySample[];
    readonly evaluatorVersion: typeof SKILL_EVALUATOR_VERSION;
  }): Promise<readonly ReplayEvaluationResult[]>;
}

interface SafetyGateResult {
  readonly safe: boolean;
  readonly incorrectWrites: number;
  readonly mismatches: number;
  readonly details?: unknown;
}

interface SyntheticGateResult extends SafetyGateResult {
  readonly scenarios: readonly string[];
}

export interface EvolutionCoordinatorDependencies {
  readonly registry: EvolutionCoordinatorRegistry;
  readonly generator: SkillEvolutionAgent;
  readonly corpus: { snapshotForEvolution(cutoffAt: string): EvolutionTrainingSnapshot };
  readonly holdout: { openHoldout(manifestId: string): EvaluatorHoldoutSnapshot };
  readonly validator?: typeof validateSkillCandidate;
  readonly safetySimulator: { evaluate(candidate: ApplicationSkillVersion): Promise<SafetyGateResult> };
  readonly replayRunner: OfflineReplayRunner;
  readonly syntheticAts: { evaluate(candidate: ApplicationSkillVersion): Promise<SyntheticGateResult> };
  readonly onGate?: (gate: GateName) => void;
}

export interface EvolutionQualificationInput {
  readonly opportunity: EvolutionOpportunity;
  readonly parent: ApplicationSkillVersion;
  readonly candidateVersion: string;
  readonly cutoffAt: string;
  readonly createdAt: string;
  readonly binding: SkillBinding;
}

export type EvolutionQualificationResult =
  | { readonly kind: "qualified"; readonly candidate: ApplicationSkillVersion; readonly reportId: string }
  | { readonly kind: "rejected"; readonly gate: GateName | "generation" | "registry"; readonly reason: string;
      readonly reportId: string }
  | { readonly kind: "duplicate"; readonly leaseId: string; readonly report?: SkillEvolutionRunRecord };

interface GateReportEntry {
  readonly name: GateName;
  readonly inputHash: string;
  readonly result: "pass" | "fail";
  readonly reason?: string;
  readonly output?: unknown;
}

export function createEvolutionCoordinator(dependencies: EvolutionCoordinatorDependencies) {
  const validate = dependencies.validator ?? validateSkillCandidate;
  return Object.freeze({
    async qualify(input: EvolutionQualificationInput): Promise<EvolutionQualificationResult> {
      const leaseId = stableRunId("evolution-lease", input.opportunity.opportunityId);
      const reportId = stableRunId("evolution-report", input.opportunity.opportunityId);
      if (!acquireLease(dependencies.registry, leaseId, input)) {
        return deepFreeze({
          kind: "duplicate",
          leaseId,
          ...(dependencies.registry.getEvolutionRun(reportId) === undefined
            ? {}
            : { report: dependencies.registry.getEvolutionRun(reportId)! })
        });
      }

      const gates: GateReportEntry[] = [];
      const allocationBefore = dependencies.registry.getPageAllocation({
        site: input.parent.site,
        pageFingerprintHash: input.opportunity.scope.pageFingerprintHash
      });
      let training: EvolutionTrainingSnapshot;
      let generated: Awaited<ReturnType<SkillEvolutionAgent["generate"]>>;
      try {
        training = dependencies.corpus.snapshotForEvolution(input.cutoffAt);
        generated = await dependencies.generator.generate({
          evolutionRunId: leaseId,
          candidateVersion: input.candidateVersion,
          createdAt: input.createdAt,
          parent: input.parent,
          trainingExamples: training.training.list(),
          opportunity: modelOpportunity(input.opportunity)
        });
      } catch (error) {
        return reject("generation", `generation_error:${errorCode(error)}`, undefined);
      }
      if (generated.kind === "rejected") {
        return reject("generation", generated.reason, undefined);
      }

      const candidateValue = {
        ...input.parent,
        version: input.candidateVersion,
        parentVersion: input.parent.version,
        status: "candidate",
        content: generated.content,
        contentHash: generated.contentHash,
        createdBy: {
          kind: "evolution_agent",
          actorId: "skill-evolution-agent",
          evolutionRunId: leaseId
        },
        createdAt: input.createdAt
      };
      const schemaResult = ApplicationSkillVersionSchema.safeParse(candidateValue);
      const schemaHash = digest(candidateValue);
      dependencies.onGate?.("schema");
      if (!schemaResult.success) {
        gates.push({ name: "schema", inputHash: schemaHash, result: "fail", reason: "candidate_schema_invalid" });
        return reject("schema", "candidate_schema_invalid", undefined);
      }
      const candidate = schemaResult.data;
      if (candidate.contentHash !== canonicalSkillContentHash(candidate.content)) {
        gates.push({ name: "schema", inputHash: schemaHash, result: "fail", reason: "candidate_content_hash_mismatch" });
        return reject("schema", "candidate_content_hash_mismatch", candidate);
      }
      gates.push({ name: "schema", inputHash: schemaHash, result: "pass" });

      const semanticResult = validate(candidate, input.parent);
      dependencies.onGate?.("semantics");
      if (!semanticResult.valid) {
        gates.push({
          name: "semantics",
          inputHash: digest({ parent: input.parent.contentHash, candidate: candidate.contentHash }),
          result: "fail",
          reason: "candidate_semantics_invalid",
          output: semanticResult.issues
        });
        return reject("semantics", "candidate_semantics_invalid", candidate);
      }
      gates.push({
        name: "semantics",
        inputHash: digest({ parent: input.parent.contentHash, candidate: candidate.contentHash }),
        result: "pass"
      });

      let safety: SafetyGateResult;
      try {
        safety = await dependencies.safetySimulator.evaluate(candidate);
      } catch (error) {
        dependencies.onGate?.("safety-simulation");
        gates.push({
          name: "safety-simulation",
          inputHash: digest({ candidate: candidate.contentHash, simulatorVersion: 1 }),
          result: "fail",
          reason: "safety_simulation_error",
          output: { code: errorCode(error) }
        });
        return reject("safety-simulation", "safety_simulation_error", candidate);
      }
      dependencies.onGate?.("safety-simulation");
      const safetyPassed = safety.safe && safety.incorrectWrites === 0 && safety.mismatches === 0;
      gates.push({
        name: "safety-simulation",
        inputHash: digest({ candidate: candidate.contentHash, simulatorVersion: 1 }),
        result: safetyPassed ? "pass" : "fail",
        ...(safetyPassed ? {} : { reason: "safety_simulation_failed" }),
        output: safety
      });
      if (!safetyPassed) return reject("safety-simulation", "safety_simulation_failed", candidate);

      let pairedSamples: readonly RedactedReplaySample[] = [];
      let championReplay: readonly ReplayEvaluationResult[] = [];
      let candidateReplay: readonly ReplayEvaluationResult[] = [];
      try {
        const hidden = dependencies.holdout.openHoldout(training.manifestId);
        pairedSamples = hidden.samples.filter((sample) => sample.site === input.parent.site);
        championReplay = await dependencies.replayRunner.evaluate({
          skill: input.parent,
          samples: pairedSamples,
          evaluatorVersion: SKILL_EVALUATOR_VERSION
        });
        candidateReplay = await dependencies.replayRunner.evaluate({
          skill: candidate,
          samples: pairedSamples,
          evaluatorVersion: SKILL_EVALUATOR_VERSION
        });
      } catch (error) {
        dependencies.onGate?.("hidden-holdout-replay");
        gates.push({
          name: "hidden-holdout-replay",
          inputHash: digest({
            manifestId: training.manifestId,
            sampleIds: pairedSamples.map(({ sampleId }) => sampleId),
            champion: input.parent.contentHash,
            candidate: candidate.contentHash,
            evaluatorVersion: SKILL_EVALUATOR_VERSION
          }),
          result: "fail",
          reason: "holdout_replay_error",
          output: { code: errorCode(error) }
        });
        return reject("hidden-holdout-replay", "holdout_replay_error", candidate);
      }
      const replayDecision = assessReplay(input.opportunity, pairedSamples, championReplay, candidateReplay);
      dependencies.onGate?.("hidden-holdout-replay");
      gates.push({
        name: "hidden-holdout-replay",
        inputHash: digest({
          manifestId: training.manifestId,
          sampleIds: pairedSamples.map(({ sampleId }) => sampleId),
          champion: input.parent.contentHash,
          candidate: candidate.contentHash,
          evaluatorVersion: SKILL_EVALUATOR_VERSION
        }),
        result: replayDecision.passed ? "pass" : "fail",
        ...(replayDecision.passed ? {} : { reason: replayDecision.reason }),
        output: replayDecision.output
      });
      if (!replayDecision.passed) {
        return reject("hidden-holdout-replay", replayDecision.reason, candidate);
      }

      let synthetic: SyntheticGateResult;
      try {
        synthetic = await dependencies.syntheticAts.evaluate(candidate);
      } catch (error) {
        dependencies.onGate?.("synthetic-ats");
        gates.push({
          name: "synthetic-ats",
          inputHash: digest({ candidate: candidate.contentHash, scenarios: REQUIRED_SYNTHETIC_SCENARIOS }),
          result: "fail",
          reason: "synthetic_ats_error",
          output: { code: errorCode(error) }
        });
        return reject("synthetic-ats", "synthetic_ats_error", candidate);
      }
      dependencies.onGate?.("synthetic-ats");
      const missingScenarios = REQUIRED_SYNTHETIC_SCENARIOS.filter((scenario) => !synthetic.scenarios.includes(scenario));
      const syntheticPassed = synthetic.safe
        && synthetic.incorrectWrites === 0
        && synthetic.mismatches === 0
        && missingScenarios.length === 0;
      gates.push({
        name: "synthetic-ats",
        inputHash: digest({ candidate: candidate.contentHash, scenarios: REQUIRED_SYNTHETIC_SCENARIOS }),
        result: syntheticPassed ? "pass" : "fail",
        ...(syntheticPassed ? {} : { reason: "synthetic_ats_failed" }),
        output: { ...synthetic, missingScenarios }
      });
      if (!syntheticPassed) return reject("synthetic-ats", "synthetic_ats_failed", candidate);

      try {
        const created = dependencies.registry.createVersion(candidate);
        if (created.version !== candidate.version) throw new Error("candidate_version_deduplicated_elsewhere");
        const stored = dependencies.registry.getVersion(candidate.skillId, candidate.version);
        if (stored?.contentHash !== candidate.contentHash || stored.status !== "candidate") {
          throw new Error("candidate_persistence_mismatch");
        }
        dependencies.registry.bindPage(input.binding);
        const transitioned = dependencies.registry.compareAndSetStatus(
          {
            skillId: candidate.skillId,
            site: candidate.site,
            pageFingerprintHash: input.opportunity.scope.pageFingerprintHash
          },
          "candidate",
          "replay_qualified",
          candidate.version
        );
        if (!transitioned) throw new Error("candidate_status_transition_failed");
        const allocationAfter = dependencies.registry.getPageAllocation({
          site: input.parent.site,
          pageFingerprintHash: input.opportunity.scope.pageFingerprintHash
        });
        if (digest(allocationAfter) !== digest(allocationBefore)) throw new Error("traffic_allocation_changed");
      } catch (error) {
        return reject("registry", errorCode(error), candidate);
      }

      appendReport(dependencies.registry, {
        reportId,
        input,
        candidate,
        gates,
        decision: "qualified"
      });
      return deepFreeze({ kind: "qualified", candidate: { ...candidate, status: "replay_qualified" }, reportId });

      function reject(
        gate: RejectionGate,
        reason: string,
        candidate: ApplicationSkillVersion | undefined
      ): EvolutionQualificationResult {
        appendReport(dependencies.registry, {
          reportId,
          input,
          ...(candidate === undefined ? {} : { candidate }),
          gates,
          decision: "rejected",
          rejectionReason: reason
        });
        return deepFreeze({ kind: "rejected", gate, reason, reportId });
      }
    }
  });
}

function assessReplay(
  opportunity: EvolutionOpportunity,
  samples: readonly RedactedReplaySample[],
  championResults: readonly ReplayEvaluationResult[],
  candidateResults: readonly ReplayEvaluationResult[]
): { passed: boolean; reason: string; output: unknown } {
  const expectedIds = samples.map(({ sampleId }) => sampleId);
  const champion = evaluationMap(championResults, expectedIds);
  const candidate = evaluationMap(candidateResults, expectedIds);
  if (champion === undefined || candidate === undefined) {
    return { passed: false, reason: "replay_sample_pairing_invalid", output: { expectedIds } };
  }
  const targetIds = samples
    .filter((sample) => matchesTargetStratum(sample, opportunity))
    .map(({ sampleId }) => sampleId);
  if (targetIds.length === 0) {
    return { passed: false, reason: "target_stratum_empty", output: { expectedIds, targetIds } };
  }
  const championGlobal = aggregateEvaluations([...champion.values()]);
  const candidateGlobal = aggregateEvaluations([...candidate.values()]);
  const championTarget = aggregateByIds(champion, targetIds);
  const candidateTarget = aggregateByIds(candidate, targetIds);
  const hasIncorrectWrite = [...candidate.values()].some((item) => (
    item.safetyViolations > 0 || item.incorrectWrites > 0
  ));
  const globallyNonInferior = compareEvaluation(candidateGlobal, championGlobal) !== "right";
  const targetImproved = compareEvaluation(candidateTarget, championTarget) === "left";
  const passed = !hasIncorrectWrite && globallyNonInferior && targetImproved;
  return {
    passed,
    reason: hasIncorrectWrite
      ? "candidate_replay_write_or_safety_failure"
      : !targetImproved
        ? "target_stratum_not_better"
        : !globallyNonInferior
          ? "global_replay_regression"
          : "passed",
    output: { championGlobal, candidateGlobal, championTarget, candidateTarget, targetIds }
  };
}

function matchesTargetStratum(sample: RedactedReplaySample, opportunity: EvolutionOpportunity): boolean {
  if (sample.site !== opportunity.scope.site
    || sample.pageFingerprintHash !== opportunity.scope.pageFingerprintHash) return false;
  if (opportunity.theme.errorClass === "fingerprint_drift") return true;
  const semantic = opportunity.theme.semantic;
  if (sample.observedOutcome.firstError?.errorClass === opportunity.theme.errorClass
    && (semantic === undefined || sample.observedOutcome.firstError.semantic === semantic)) return true;
  return sample.observedOutcome.fieldOutcomes.some((outcome) => (
    outcome.errorClass === opportunity.theme.errorClass
    && (semantic === undefined || outcome.semantic === semantic)
  ));
}

function evaluationMap(
  results: readonly ReplayEvaluationResult[],
  expectedIds: readonly string[]
): Map<string, SkillEvaluation> | undefined {
  const mapped = new Map<string, SkillEvaluation>();
  for (const result of results) {
    const evaluation = SkillEvaluationSchema.safeParse(result.evaluation);
    if (!evaluation.success || evaluation.data.evaluatorVersion !== SKILL_EVALUATOR_VERSION || mapped.has(result.sampleId)) {
      return undefined;
    }
    mapped.set(result.sampleId, evaluation.data);
  }
  if (mapped.size !== expectedIds.length || expectedIds.some((sampleId) => !mapped.has(sampleId))) return undefined;
  return mapped;
}

function aggregateByIds(
  values: ReadonlyMap<string, SkillEvaluation>,
  ids: readonly string[]
): AggregatedSkillEvaluation {
  return aggregateEvaluations(ids.map((id) => values.get(id)!));
}

function acquireLease(
  registry: EvolutionCoordinatorRegistry,
  leaseId: string,
  input: EvolutionQualificationInput
): boolean {
  if (registry.getEvolutionRun(leaseId) !== undefined) return false;
  try {
    registry.appendEvolutionRun({
      runId: leaseId,
      trigger: "offline_qualification_lease",
      inputRecordIds: input.opportunity.evidenceRecordIds,
      finalStatus: "candidate",
      payload: {
        kind: "offline_qualification_lease",
        schemaVersion: 1,
        opportunityId: input.opportunity.opportunityId,
        opportunityHash: digest(input.opportunity),
        parentContentHash: input.parent.contentHash,
        candidateVersion: input.candidateVersion
      },
      createdAt: input.createdAt
    });
    return true;
  } catch (error) {
    if (registry.getEvolutionRun(leaseId) !== undefined) return false;
    throw error;
  }
}

function appendReport(
  registry: EvolutionCoordinatorRegistry,
  input: {
    readonly reportId: string;
    readonly input: EvolutionQualificationInput;
    readonly candidate?: ApplicationSkillVersion;
    readonly gates: readonly GateReportEntry[];
    readonly decision: "qualified" | "rejected";
    readonly rejectionReason?: string;
  }
): void {
  registry.appendEvolutionRun({
    runId: input.reportId,
    trigger: "offline_qualification_report",
    inputRecordIds: input.input.opportunity.evidenceRecordIds,
    ...(input.candidate === undefined ? {} : {
      candidateSkillId: input.candidate.skillId,
      candidateVersion: input.candidate.version
    }),
    finalStatus: input.decision === "qualified" ? "replay_qualified" : "candidate",
    payload: {
      kind: "offline_qualification_report",
      schemaVersion: 1,
      opportunityId: input.input.opportunity.opportunityId,
      evaluatorVersion: SKILL_EVALUATOR_VERSION,
      decision: input.decision,
      ...(input.rejectionReason === undefined ? {} : { rejectionReason: input.rejectionReason }),
      gates: input.gates
    },
    createdAt: input.input.createdAt
  });
}

function modelOpportunity(opportunity: EvolutionOpportunity) {
  return {
    opportunityId: opportunity.opportunityId,
    theme: opportunity.theme,
    triggers: opportunity.triggers,
    executionChain: []
  };
}

function stableRunId(prefix: string, opportunityId: string): string {
  const direct = `${prefix}-${opportunityId}`;
  return direct.length <= 128 ? direct : `${prefix}-${digest(opportunityId).slice(0, 40)}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "registry_failure";
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
