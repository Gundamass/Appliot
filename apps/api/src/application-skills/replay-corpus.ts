import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ApplicationFieldSemanticSchema,
  SkillExecutionRecordSchema,
  type SkillExecutionRecord
} from "@resume/contracts";
import {
  projectReplayExecutionOutcome,
  ReplayExecutionOutcomeSchema,
  type ReplayExecutionOutcome
} from "./skill-execution-recorder.js";
import type {
  SkillEvolutionRunRecord,
  SkillReplaySampleRecord
} from "./skill-registry.js";

const IdentifierSchema = z.string().min(1).max(128).regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ControlRoleSchema = z.enum([
  "none", "textbox", "combobox", "checkbox", "radio", "button", "option", "listbox", "link"
]);
const ControlTagSchema = z.enum(["input", "textarea", "select", "button", "fieldset"]);
const ControlTypeSchema = z.enum([
  "text", "tel", "email", "url", "number", "date", "month", "checkbox", "radio", "file",
  "hidden", "select-one", "select-multiple", "textarea", "button", "submit"
]);
const ParentRoleSchema = z.enum(["none", "form", "group", "fieldset", "radiogroup", "listbox"]);
const RelativeStructureSchema = z.object({
  parentRole: ParentRoleSchema,
  depth: z.number().int().min(0).max(32),
  siblingIndex: z.number().int().min(0).max(10_000)
}).strict();

const ReplayControlInputSchema = z.object({
  role: ControlRoleSchema,
  tag: ControlTagSchema,
  type: ControlTypeSchema,
  label: z.string().max(2_000),
  options: z.array(z.string().max(2_000)).max(500),
  hidden: z.boolean(),
  relativeStructure: RelativeStructureSchema
}).passthrough();

const ReplayCorpusAppendInputSchema = z.object({
  sampleId: IdentifierSchema,
  capturedAt: z.string().datetime(),
  site: z.enum(["moka", "dji", "baidu"]),
  pageFingerprintHash: HashSchema,
  scenarioClass: IdentifierSchema,
  page: z.object({
    route: z.string().max(4_000).optional(),
    controls: z.array(ReplayControlInputSchema).max(500)
  }).passthrough(),
  expectedSemantics: z.array(ApplicationFieldSemanticSchema).max(200),
  executionRecord: SkillExecutionRecordSchema,
  sensitiveContext: z.unknown().optional()
}).passthrough();

const RedactedReplayControlSchema = z.object({
  role: ControlRoleSchema,
  tag: ControlTagSchema,
  type: ControlTypeSchema,
  labelHash: HashSchema,
  optionHashes: z.array(HashSchema).max(500),
  relativeStructure: RelativeStructureSchema,
  hidden: z.boolean()
}).strict();

const StoredSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.string().datetime(),
  scenarioClass: IdentifierSchema,
  controls: z.array(RedactedReplayControlSchema).max(500)
}).strict();

const StoredExpectationSchema = z.object({
  schemaVersion: z.literal(1),
  expectedSemantics: z.array(ApplicationFieldSemanticSchema).max(200),
  observedOutcome: ReplayExecutionOutcomeSchema
}).strict();

const ReplayManifestSchema = z.object({
  kind: z.literal("replay_corpus_manifest"),
  schemaVersion: z.literal(1),
  manifestId: IdentifierSchema,
  cutoffAt: z.string().datetime(),
  trainingSampleIds: z.array(IdentifierSchema),
  holdoutSampleIds: z.array(IdentifierSchema),
  excludedAfterCutoff: z.number().int().nonnegative(),
  partitionDigest: HashSchema
}).strict();

export interface ReplayControlInput {
  readonly role: string;
  readonly tag: string;
  readonly type: string;
  readonly label: string;
  readonly options: readonly string[];
  readonly hidden: boolean;
  readonly relativeStructure: {
    readonly parentRole: string;
    readonly depth: number;
    readonly siblingIndex: number;
  };
  readonly [key: string]: unknown;
}

export interface ReplayCorpusAppendInput {
  readonly sampleId: string;
  readonly capturedAt: string;
  readonly site: "moka" | "dji" | "baidu";
  readonly pageFingerprintHash: string;
  readonly scenarioClass: string;
  readonly page: {
    readonly route?: string;
    readonly controls: readonly ReplayControlInput[];
    readonly [key: string]: unknown;
  };
  readonly expectedSemantics: readonly string[];
  readonly executionRecord: SkillExecutionRecord;
  readonly sensitiveContext?: unknown;
  readonly [key: string]: unknown;
}

export interface RedactedReplayControl {
  readonly role: string;
  readonly tag: string;
  readonly type: string;
  readonly labelHash: string;
  readonly optionHashes: readonly string[];
  readonly relativeStructure: {
    readonly parentRole: string;
    readonly depth: number;
    readonly siblingIndex: number;
  };
  readonly hidden: boolean;
}

export interface CapturedRedactedReplaySample {
  readonly sampleId: string;
  readonly capturedAt: string;
  readonly site: "moka" | "dji" | "baidu";
  readonly pageFingerprintHash: string;
  readonly scenarioClass: string;
  readonly controls: readonly RedactedReplayControl[];
  readonly expectedSemantics: readonly string[];
  readonly observedOutcome: ReplayExecutionOutcome;
}

export interface RedactedReplaySample extends CapturedRedactedReplaySample {
  readonly partition: "training" | "holdout";
}

export interface ReplayTrainingAccess {
  list(): readonly RedactedReplaySample[];
  get(sampleId: string): RedactedReplaySample | undefined;
}

export interface EvolutionTrainingSnapshot {
  readonly manifestId: string;
  readonly cutoffAt: string;
  readonly trainingCount: number;
  readonly training: ReplayTrainingAccess;
}

export interface FrozenReplayManifest {
  readonly manifestId: string;
  readonly cutoffAt: string;
  readonly trainingSampleIds: readonly string[];
  readonly holdoutSampleIds: readonly string[];
  readonly excludedAfterCutoff: number;
  readonly partitionDigest: string;
}

export interface EvaluatorHoldoutSnapshot {
  readonly manifest: FrozenReplayManifest;
  readonly samples: readonly RedactedReplaySample[];
}

export interface ReplayCorpusRegistryPort {
  appendReplaySample(input: SkillReplaySampleRecord): void;
  getReplaySample(sampleId: string): SkillReplaySampleRecord | undefined;
  listReplaySamplesThrough(cutoffAt: string): SkillReplaySampleRecord[];
  listReplaySamples(): SkillReplaySampleRecord[];
  appendEvolutionRun(input: SkillEvolutionRunRecord): void;
  getEvolutionRun(runId: string): SkillEvolutionRunRecord | undefined;
}

export class ReplayCorpus {
  public constructor(private readonly registry: ReplayCorpusRegistryPort) {}

  public append(input: ReplayCorpusAppendInput): CapturedRedactedReplaySample {
    const parsed = ReplayCorpusAppendInputSchema.parse(input);
    const sample = redactSample(parsed);
    this.registry.appendReplaySample(encodeStoredSample(sample));
    return sample;
  }

  public snapshotForEvolution(cutoffAt: string): EvolutionTrainingSnapshot {
    const parsedCutoff = z.string().datetime().parse(cutoffAt);
    const manifestId = manifestIdFor(parsedCutoff);
    const existing = this.registry.getEvolutionRun(manifestId);
    const manifest = existing === undefined
      ? this.createManifest(manifestId, parsedCutoff)
      : manifestFromRun(existing);
    const trainingSamples = deepFreeze(manifest.trainingSampleIds.map((sampleId) => (
      withPartition(this.requireSample(sampleId), "training")
    )));
    const trainingById = new Map(trainingSamples.map((sample) => [sample.sampleId, sample]));
    const training = Object.freeze<ReplayTrainingAccess>({
      list: () => trainingSamples,
      get: (sampleId) => trainingById.get(sampleId)
    });
    return Object.freeze({
      manifestId: manifest.manifestId,
      cutoffAt: manifest.cutoffAt,
      trainingCount: trainingSamples.length,
      training
    });
  }

  private createManifest(manifestId: string, cutoffAt: string): FrozenReplayManifest {
    const eligible = this.registry.listReplaySamplesThrough(cutoffAt).map(decodeStoredSample);
    const { trainingSampleIds, holdoutSampleIds } = partition(eligible);
    const excludedAfterCutoff = this.registry.listReplaySamples().length - eligible.length;
    const payload = ReplayManifestSchema.parse({
      kind: "replay_corpus_manifest",
      schemaVersion: 1,
      manifestId,
      cutoffAt,
      trainingSampleIds,
      holdoutSampleIds,
      excludedAfterCutoff,
      partitionDigest: digest({ cutoffAt, trainingSampleIds, holdoutSampleIds })
    });
    this.registry.appendEvolutionRun({
      runId: manifestId,
      trigger: "replay_corpus_snapshot",
      inputRecordIds: [...trainingSampleIds, ...holdoutSampleIds],
      finalStatus: "candidate",
      payload,
      createdAt: cutoffAt
    });
    return freezeManifest(payload);
  }

  private requireSample(sampleId: string): CapturedRedactedReplaySample {
    const record = this.registry.getReplaySample(sampleId);
    if (record === undefined) throw new Error("skill_replay_manifest_sample_missing");
    return decodeStoredSample(record);
  }
}

export class ReplayCorpusEvaluatorAccess {
  public constructor(private readonly registry: ReplayCorpusRegistryPort) {}

  public openHoldout(manifestId: string): EvaluatorHoldoutSnapshot {
    const run = this.registry.getEvolutionRun(manifestId);
    if (run === undefined) throw new Error("skill_replay_manifest_not_found");
    const manifest = manifestFromRun(run);
    const samples = deepFreeze(manifest.holdoutSampleIds.map((sampleId) => {
      const record = this.registry.getReplaySample(sampleId);
      if (record === undefined) throw new Error("skill_replay_manifest_sample_missing");
      return withPartition(decodeStoredSample(record), "holdout");
    }));
    return Object.freeze({ manifest, samples });
  }
}

export function createReplayCorpusPorts(registry: ReplayCorpusRegistryPort): {
  readonly corpus: ReplayCorpus;
  readonly evaluator: ReplayCorpusEvaluatorAccess;
} {
  return Object.freeze({
    corpus: new ReplayCorpus(registry),
    evaluator: new ReplayCorpusEvaluatorAccess(registry)
  });
}

function redactSample(input: z.infer<typeof ReplayCorpusAppendInputSchema>): CapturedRedactedReplaySample {
  return deepFreeze({
    sampleId: input.sampleId,
    capturedAt: input.capturedAt,
    site: input.site,
    pageFingerprintHash: input.pageFingerprintHash,
    scenarioClass: input.scenarioClass,
    controls: input.page.controls.map((control) => ({
      role: control.role,
      tag: control.tag,
      type: control.type,
      labelHash: digestText(control.label),
      optionHashes: control.options.map(digestText),
      relativeStructure: control.relativeStructure,
      hidden: control.hidden
    })),
    expectedSemantics: [...new Set(input.expectedSemantics)],
    observedOutcome: projectReplayExecutionOutcome(input.executionRecord)
  });
}

function encodeStoredSample(sample: CapturedRedactedReplaySample): SkillReplaySampleRecord {
  return {
    sampleId: sample.sampleId,
    site: sample.site,
    pageFingerprintHash: sample.pageFingerprintHash,
    // Captures are quarantined by default. A frozen manifest is the only authority
    // that can expose a sample through the training capability.
    split: "holdout",
    redactedSnapshot: {
      schemaVersion: 1,
      capturedAt: sample.capturedAt,
      scenarioClass: sample.scenarioClass,
      controls: sample.controls
    },
    expectedActions: {
      schemaVersion: 1,
      expectedSemantics: sample.expectedSemantics,
      observedOutcome: sample.observedOutcome
    },
    createdAt: sample.capturedAt
  };
}

function decodeStoredSample(record: SkillReplaySampleRecord): CapturedRedactedReplaySample {
  const snapshot = StoredSnapshotSchema.parse(record.redactedSnapshot);
  const expectation = StoredExpectationSchema.parse(record.expectedActions);
  if (snapshot.capturedAt !== record.createdAt) throw new Error("skill_replay_sample_timestamp_mismatch");
  return deepFreeze({
    sampleId: record.sampleId,
    capturedAt: snapshot.capturedAt,
    site: record.site,
    pageFingerprintHash: record.pageFingerprintHash,
    scenarioClass: snapshot.scenarioClass,
    controls: snapshot.controls,
    expectedSemantics: expectation.expectedSemantics,
    observedOutcome: expectation.observedOutcome
  });
}

function partition(samples: readonly CapturedRedactedReplaySample[]): {
  trainingSampleIds: string[];
  holdoutSampleIds: string[];
} {
  const strata = new Map<string, CapturedRedactedReplaySample[]>();
  for (const sample of samples) {
    const key = [sample.site, sample.pageFingerprintHash, sample.scenarioClass].join("\0");
    const members = strata.get(key) ?? [];
    members.push(sample);
    strata.set(key, members);
  }

  const trainingSampleIds: string[] = [];
  const holdoutSampleIds: string[] = [];
  for (const key of [...strata.keys()].sort()) {
    const members = strata.get(key)!.sort(compareCapturedSamples);
    const trainingCount = Math.floor(members.length * 0.8);
    trainingSampleIds.push(...members.slice(0, trainingCount).map(({ sampleId }) => sampleId));
    holdoutSampleIds.push(...members.slice(trainingCount).map(({ sampleId }) => sampleId));
  }
  return { trainingSampleIds, holdoutSampleIds };
}

function compareCapturedSamples(left: CapturedRedactedReplaySample, right: CapturedRedactedReplaySample): number {
  return left.capturedAt.localeCompare(right.capturedAt) || left.sampleId.localeCompare(right.sampleId);
}

function manifestFromRun(run: SkillEvolutionRunRecord): FrozenReplayManifest {
  if (run.trigger !== "replay_corpus_snapshot") throw new Error("skill_replay_manifest_invalid");
  const payload = ReplayManifestSchema.parse(run.payload);
  if (payload.manifestId !== run.runId) throw new Error("skill_replay_manifest_invalid");
  const expectedIds = [...payload.trainingSampleIds, ...payload.holdoutSampleIds];
  if (JSON.stringify(expectedIds) !== JSON.stringify(run.inputRecordIds)) {
    throw new Error("skill_replay_manifest_invalid");
  }
  if (payload.partitionDigest !== digest({
    cutoffAt: payload.cutoffAt,
    trainingSampleIds: payload.trainingSampleIds,
    holdoutSampleIds: payload.holdoutSampleIds
  })) {
    throw new Error("skill_replay_manifest_invalid");
  }
  return freezeManifest(payload);
}

function freezeManifest(payload: z.infer<typeof ReplayManifestSchema>): FrozenReplayManifest {
  return deepFreeze({
    manifestId: payload.manifestId,
    cutoffAt: payload.cutoffAt,
    trainingSampleIds: payload.trainingSampleIds,
    holdoutSampleIds: payload.holdoutSampleIds,
    excludedAfterCutoff: payload.excludedAfterCutoff,
    partitionDigest: payload.partitionDigest
  });
}

function withPartition(
  sample: CapturedRedactedReplaySample,
  partitionValue: "training" | "holdout"
): RedactedReplaySample {
  return deepFreeze({ ...sample, partition: partitionValue });
}

function manifestIdFor(cutoffAt: string): string {
  return `replay-manifest-${digest({ schemaVersion: 1, cutoffAt }).slice(0, 32)}`;
}

function digestText(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
