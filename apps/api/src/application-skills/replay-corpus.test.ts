import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillExecutionRecord } from "@resume/contracts";
import { createReplayCorpusPorts, type ReplayCorpusAppendInput } from "./replay-corpus.js";
import { migrateApplicationSkillSchema } from "./skill-schema-migration.js";
import { SkillRegistry } from "./skill-registry.js";

describe("ReplayCorpus", () => {
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

  it("stores only replayable structure and outcomes while removing raw profile and secret material", () => {
    const { corpus } = createReplayCorpusPorts(registry);

    const stored = corpus.append(sampleFixture("sample-redaction", "2026-09-07T08:00:00.000Z", {
      page: {
        route: "/apply?queryToken=query-secret-9384",
        controls: [
          control("textbox", "input", "text", "姓名", [], 0, "张三"),
          control("textbox", "input", "tel", "手机号码", [], 1, "13800138000"),
          control("textbox", "input", "email", "邮箱", [], 2, "candidate@example.com"),
          control("textbox", "textarea", "text", "联系地址", [], 3, "北京市海淀区秘密地址"),
          control("textbox", "textarea", "text", "个人简历", [], 4, "十年私人工作经历"),
          {
            ...control("none", "input", "hidden", "审批令牌", [], 5, "approval-secret-7749"),
            hidden: true
          },
          control("combobox", "select", "select-one", "最高学历", ["本科", "硕士"], 6, "本科")
        ]
      },
      sensitiveContext: {
        name: "张三",
        phone: "13800138000",
        email: "candidate@example.com",
        address: "北京市海淀区秘密地址",
        resumeText: "十年私人工作经历",
        approvalToken: "approval-secret-7749"
      }
    }));

    expect(stored.controls).toHaveLength(7);
    expect(stored.controls[0]).toEqual({
      role: "textbox",
      tag: "input",
      type: "text",
      labelHash: sha256("姓名"),
      optionHashes: [],
      relativeStructure: { parentRole: "form", depth: 1, siblingIndex: 0 },
      hidden: false
    });
    expect(stored.controls[5]).toMatchObject({
      role: "none",
      tag: "input",
      type: "hidden",
      labelHash: sha256("审批令牌"),
      hidden: true
    });
    expect(stored.controls[6]!.optionHashes).toEqual([sha256("本科"), sha256("硕士")]);
    expect(stored.expectedSemantics).toEqual(["basics.name", "basics.phone"]);
    expect(stored.observedOutcome).toMatchObject({
      terminalResult: "completed_pre_submit",
      auditMismatchClasses: [],
      counts: { observed: 2, planned: 2, verified: 2 }
    });

    const serialized = JSON.stringify(database.prepare(
      "SELECT * FROM skill_replay_samples WHERE sample_id = ?"
    ).get("sample-redaction"));
    for (const forbidden of [
      "张三",
      "13800138000",
      "candidate@example.com",
      "北京市海淀区秘密地址",
      "十年私人工作经历",
      "query-secret-9384",
      "approval-secret-7749",
      "本科",
      "硕士"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("freezes deterministic older-80-percent training and newer-20-percent holdout per stratum", () => {
    const { corpus, evaluator } = createReplayCorpusPorts(registry);
    const captures = [
      ["sample-a-2", "2026-09-07T08:00:01.000Z", "stable"],
      ["sample-a-1", "2026-09-07T08:00:01.000Z", "stable"],
      ["sample-a-3", "2026-09-07T08:00:02.000Z", "stable"],
      ["sample-a-4", "2026-09-07T08:00:03.000Z", "stable"],
      ["sample-a-5", "2026-09-07T08:00:04.000Z", "stable"],
      ["sample-b-1", "2026-09-07T08:00:00.000Z", "renamed-label"],
      ["sample-b-2", "2026-09-07T08:00:01.000Z", "renamed-label"],
      ["sample-b-3", "2026-09-07T08:00:02.000Z", "renamed-label"],
      ["sample-b-4", "2026-09-07T08:00:03.000Z", "renamed-label"],
      ["sample-b-5", "2026-09-07T08:00:04.000Z", "renamed-label"],
      ["sample-after-cutoff", "2026-09-07T09:00:00.000Z", "stable"]
    ] as const;
    for (const [sampleId, capturedAt, scenarioClass] of captures) {
      corpus.append(sampleFixture(sampleId, capturedAt, { scenarioClass }));
    }

    const snapshot = corpus.snapshotForEvolution("2026-09-07T08:30:00.000Z");
    const trainingIds = snapshot.training.list().map(({ sampleId }) => sampleId);

    expect(trainingIds).toEqual([
      "sample-b-1",
      "sample-b-2",
      "sample-b-3",
      "sample-b-4",
      "sample-a-1",
      "sample-a-2",
      "sample-a-3",
      "sample-a-4"
    ]);
    expect(snapshot.training.get("sample-a-5")).toBeUndefined();
    expect(snapshot.training.get("sample-after-cutoff")).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain("sample-a-5");
    expect(JSON.stringify(snapshot)).not.toContain("sample-b-5");
    expect(Object.isFrozen(snapshot.training.list())).toBe(true);

    const hidden = evaluator.openHoldout(snapshot.manifestId);
    expect(hidden.samples.map(({ sampleId }) => sampleId)).toEqual(["sample-b-5", "sample-a-5"]);
    expect(hidden.manifest.trainingSampleIds).toEqual(trainingIds);
    expect(hidden.manifest.holdoutSampleIds).toEqual(["sample-b-5", "sample-a-5"]);
    expect(hidden.manifest.excludedAfterCutoff).toBe(1);
    expect(Object.isFrozen(hidden.manifest)).toBe(true);
    expect(Object.isFrozen(hidden.manifest.holdoutSampleIds)).toBe(true);
    expect(Object.isFrozen(hidden.samples[0])).toBe(true);
  });

  it("never repartitions an existing cutoff manifest when later records arrive", () => {
    const { corpus, evaluator } = createReplayCorpusPorts(registry);
    for (let index = 1; index <= 5; index += 1) {
      corpus.append(sampleFixture(`sample-${index}`, `2026-09-07T08:00:0${index}.000Z`));
    }
    const first = corpus.snapshotForEvolution("2026-09-07T08:30:00.000Z");
    const firstTraining = first.training.list().map(({ sampleId }) => sampleId);
    const firstHoldout = evaluator.openHoldout(first.manifestId).samples.map(({ sampleId }) => sampleId);

    corpus.append(sampleFixture("sample-late-ingest", "2026-09-07T07:59:59.000Z"));
    const restarted = createReplayCorpusPorts(registry);
    const repeated = restarted.corpus.snapshotForEvolution("2026-09-07T08:30:00.000Z");

    expect(repeated.manifestId).toBe(first.manifestId);
    expect(repeated.training.list().map(({ sampleId }) => sampleId)).toEqual(firstTraining);
    expect(restarted.evaluator.openHoldout(repeated.manifestId).samples.map(({ sampleId }) => sampleId)).toEqual(firstHoldout);
    expect(repeated.training.get("sample-late-ingest")).toBeUndefined();
  });

  it("makes append idempotent only for an identical sample payload", () => {
    const { corpus } = createReplayCorpusPorts(registry);
    const input = sampleFixture("sample-idempotent", "2026-09-07T08:00:00.000Z");

    expect(corpus.append(input)).toEqual(corpus.append(input));
    expect(() => corpus.append({ ...input, scenarioClass: "changed-scenario" })).toThrow(
      "skill_replay_sample_conflict"
    );
    expect(database.prepare("SELECT COUNT(*) AS count FROM skill_replay_samples").get()).toEqual({ count: 1 });
  });

  it("rejects arbitrary text in structural slots instead of treating it as safe metadata", () => {
    const { corpus } = createReplayCorpusPorts(registry);
    const input = sampleFixture("sample-unsafe-structure", "2026-09-07T08:00:00.000Z");

    expect(() => corpus.append({
      ...input,
      page: {
        controls: [{ ...input.page.controls[0]!, role: "candidate-secret" }]
      }
    })).toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM skill_replay_samples").get()).toEqual({ count: 0 });
  });
});

function sampleFixture(
  sampleId: string,
  capturedAt: string,
  overrides: Partial<ReplayCorpusAppendInput> = {}
): ReplayCorpusAppendInput {
  return {
    sampleId,
    capturedAt,
    site: "baidu",
    pageFingerprintHash: "a".repeat(64),
    scenarioClass: "stable",
    page: {
      route: "/jobs/application",
      controls: [control("textbox", "input", "text", "姓名", [], 0, "张三")]
    },
    expectedSemantics: ["basics.name", "basics.phone"],
    executionRecord: executionRecordFixture(),
    ...overrides
  };
}

function control(
  role: string,
  tag: string,
  type: string,
  label: string,
  options: string[],
  siblingIndex: number,
  value: string
) {
  return {
    role,
    tag,
    type,
    label,
    options,
    value,
    hidden: false,
    relativeStructure: { parentRole: "form", depth: 1, siblingIndex }
  };
}

function executionRecordFixture(): SkillExecutionRecord {
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
    fieldOutcomes: [
      { semantic: "basics.name", outcome: "verified" },
      { semantic: "basics.phone", outcome: "verified" }
    ],
    counts: { observed: 2, planned: 2, verified: 2, auditMismatches: 0, userCorrections: 0 },
    auditMismatchClasses: [],
    retries: 0,
    recoveries: 0,
    durationMs: 500,
    terminalResult: "completed_pre_submit",
    startedAt: "2026-09-07T08:00:00.000Z",
    completedAt: "2026-09-07T08:00:00.500Z"
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value.normalize("NFKC"), "utf8").digest("hex");
}
