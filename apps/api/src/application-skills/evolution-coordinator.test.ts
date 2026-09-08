import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ApplicationSkillContent,
  ApplicationSkillVersion,
  SkillBinding,
  SkillEvaluation
} from "@resume/contracts";
import {
  createEvolutionCoordinator,
  type EvolutionCoordinatorRegistry,
  type OfflineReplayRunner
} from "./evolution-coordinator.js";
import type { EvolutionOpportunity } from "./evolution-collector.js";
import type { RedactedReplaySample } from "./replay-corpus.js";
import { canonicalSkillContentHash, type SkillEvolutionRunRecord } from "./skill-registry.js";

const fingerprint = "a".repeat(64);
const now = "2026-09-07T10:00:00.000Z";

describe("offline skill evolution coordinator", () => {
  it("runs gates in order, hides holdout from the model, and qualifies without changing traffic", async () => {
    const events: string[] = [];
    const registry = new MemoryRegistry(parentFixture());
    const holdout = holdoutSamples();
    const generator = {
      generate: vi.fn(async (input: { trainingExamples: readonly unknown[] }) => {
        events.push("model");
        expect(input.trainingExamples).toEqual([{ sampleId: "train-1", partition: "training" }]);
        expect(JSON.stringify(input)).not.toContain("holdout-");
        const content = candidateContent();
        return { kind: "candidate" as const, content, contentHash: canonicalSkillContentHash(content) };
      })
    };
    const replayRunner: OfflineReplayRunner = {
      evaluate: vi.fn(async ({ skill, samples }: Parameters<OfflineReplayRunner["evaluate"]>[0]) => {
        events.push(`replay:${skill.version}`);
        return samples.map((sample) => ({
          sampleId: sample.sampleId,
          evaluation: evaluation(
            `${skill.version.replaceAll(".", "-")}-${sample.sampleId}`,
            skill.status === "candidate" ? passingVector() : failingVector()
          )
        }));
      })
    };
    const coordinator = createEvolutionCoordinator({
      registry,
      generator,
      corpus: {
        snapshotForEvolution: () => ({
          manifestId: "replay-manifest-1",
          cutoffAt: now,
          trainingCount: 1,
          training: { list: () => [{ sampleId: "train-1", partition: "training" }] as never, get: () => undefined }
        })
      },
      holdout: {
        openHoldout: () => {
          events.push("open-holdout");
          return { manifest: { manifestId: "replay-manifest-1" } as never, samples: holdout };
        }
      },
      safetySimulator: {
        evaluate: async () => {
          events.push("safety");
          return { safe: true, incorrectWrites: 0, mismatches: 0 };
        }
      },
      replayRunner,
      syntheticAts: {
        evaluate: async () => {
          events.push("synthetic");
          return {
            safe: true,
            incorrectWrites: 0,
            mismatches: 0,
            scenarios: ["reordered-controls", "duplicate-label", "delayed-options", "hidden-honeypot",
              "unexpected-navigation", "stale-node", "post-fill-mutation"]
          };
        }
      },
      onGate: (gate) => events.push(gate)
    });

    const before = structuredClone(registry.allocation);
    const result = await coordinator.qualify(inputFixture());

    expect(result.kind).toBe("qualified");
    expect(events).toEqual([
      "model", "schema", "semantics", "safety", "safety-simulation", "open-holdout",
      "replay:1.0.0", "replay:1.1.0", "hidden-holdout-replay", "synthetic", "synthetic-ats"
    ]);
    expect(replayRunner.evaluate).toHaveBeenNthCalledWith(1, expect.objectContaining({ samples: holdout }));
    expect(replayRunner.evaluate).toHaveBeenNthCalledWith(2, expect.objectContaining({ samples: holdout }));
    expect(registry.versions.get("1.1.0")?.status).toBe("replay_qualified");
    expect(registry.allocation).toEqual(before);
    expect(registry.runs.get("evolution-report-evolution-opportunity-1")?.payload).toEqual(
      expect.objectContaining({
        evaluatorVersion: "1.0.0",
        decision: "qualified",
        gates: expect.arrayContaining([
          expect.objectContaining({ name: "schema", result: "pass", inputHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
          expect.objectContaining({ name: "synthetic-ats", result: "pass" })
        ])
      })
    );
  });

  it.each([
    ["schema", { invalidSchema: true }, ["schema"]],
    ["semantics", { invalidSemantics: true }, ["schema", "semantics"]],
    ["safety-simulation", { unsafe: true }, ["schema", "semantics", "safety-simulation"]],
    ["hidden-holdout-replay", { replayRegression: true }, ["schema", "semantics", "safety-simulation", "hidden-holdout-replay"]],
    ["synthetic-ats", { syntheticFailure: true }, ["schema", "semantics", "safety-simulation", "hidden-holdout-replay", "synthetic-ats"]]
  ] as const)("short-circuits after the %s gate", async (failedGate, mode, expectedGates) => {
    const gates: string[] = [];
    const registry = new MemoryRegistry(parentFixture());
    const invalidSchema = "invalidSchema" in mode;
    const invalidSemantics = "invalidSemantics" in mode;
    const unsafe = "unsafe" in mode;
    const replayRegression = "replayRegression" in mode;
    const syntheticFailure = "syntheticFailure" in mode;
    const content = invalidSchema ? ({ capabilities: ["observe"] } as never) : candidateContent();
    const coordinator = createEvolutionCoordinator({
      registry,
      generator: { generate: async () => ({ kind: "candidate", content, contentHash: canonicalSkillContentHash(content) }) },
      corpus: trainingCorpus(),
      holdout: { openHoldout: () => ({ manifest: { manifestId: "replay-manifest-1" } as never, samples: holdoutSamples() }) },
      ...(invalidSemantics ? {
        validator: () => ({ valid: false, issues: [{ code: "UNREACHABLE_WORKFLOW" as const, path: "content.workflow", message: "bad" }] })
      } : {}),
      safetySimulator: {
        evaluate: async () => unsafe
          ? { safe: false, incorrectWrites: 1, mismatches: 1 }
          : { safe: true, incorrectWrites: 0, mismatches: 0 }
      },
      replayRunner: replayRunner(replayRegression),
      syntheticAts: {
        evaluate: async () => syntheticFailure
          ? { safe: false, incorrectWrites: 0, mismatches: 1, scenarios: [] }
          : { safe: true, incorrectWrites: 0, mismatches: 0, scenarios: ["all"] }
      },
      onGate: (gate) => gates.push(gate)
    });

    const result = await coordinator.qualify(inputFixture());

    expect(result).toEqual(expect.objectContaining({ kind: "rejected", gate: failedGate }));
    expect(gates).toEqual(expectedGates);
    expect(registry.versions.has("1.1.0")).toBe(false);
    expect(registry.runs.get("evolution-report-evolution-opportunity-1")?.payload).toEqual(
      expect.objectContaining({ decision: "rejected", rejectionReason: expect.any(String) })
    );
  });

  it("acquires one immutable lease per opportunity and never invokes the model twice", async () => {
    const registry = new MemoryRegistry(parentFixture());
    const generate = vi.fn(async () => ({ kind: "rejected" as const, reason: "provider" as const }));
    const coordinator = createEvolutionCoordinator({
      registry,
      generator: { generate },
      corpus: trainingCorpus(),
      holdout: { openHoldout: () => { throw new Error("must_not_open_holdout"); } },
      safetySimulator: { evaluate: async () => { throw new Error("must_not_run"); } },
      replayRunner: replayRunner(false),
      syntheticAts: { evaluate: async () => { throw new Error("must_not_run"); } }
    });

    expect((await coordinator.qualify(inputFixture())).kind).toBe("rejected");
    expect(await coordinator.qualify(inputFixture())).toEqual(expect.objectContaining({ kind: "duplicate" }));
    expect(generate).toHaveBeenCalledTimes(1);
    expect([...registry.runs.keys()]).toEqual([
      "evolution-lease-evolution-opportunity-1",
      "evolution-report-evolution-opportunity-1"
    ]);
  });

  it("excludes other ATS sites from paired replay and records runner exceptions as rejection", async () => {
    const registry = new MemoryRegistry(parentFixture());
    const foreign = { ...holdoutSamples()[0]!, sampleId: "holdout-foreign", site: "dji" as const };
    const evaluate = vi.fn(async ({ skill }: Parameters<OfflineReplayRunner["evaluate"]>[0]) => {
      if (skill.status === "candidate") throw new Error("offline_runner_unavailable");
      return holdoutSamples().map((sample) => ({
        sampleId: sample.sampleId,
        evaluation: evaluation(`champion-${sample.sampleId}`, failingVector())
      }));
    });
    const coordinator = createEvolutionCoordinator({
      registry,
      generator: {
        generate: async () => {
          const content = candidateContent();
          return { kind: "candidate", content, contentHash: canonicalSkillContentHash(content) };
        }
      },
      corpus: trainingCorpus(),
      holdout: {
        openHoldout: () => ({
          manifest: { manifestId: "replay-manifest-1" } as never,
          samples: [...holdoutSamples(), foreign]
        })
      },
      safetySimulator: { evaluate: async () => ({ safe: true, incorrectWrites: 0, mismatches: 0 }) },
      replayRunner: { evaluate },
      syntheticAts: { evaluate: async () => { throw new Error("must_not_run"); } }
    });

    expect(await coordinator.qualify(inputFixture())).toEqual(expect.objectContaining({
      kind: "rejected",
      gate: "hidden-holdout-replay",
      reason: "holdout_replay_error"
    }));
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[0]![0].samples.map(({ site }) => site)).toEqual(["baidu", "baidu"]);
    expect(registry.runs.get("evolution-report-evolution-opportunity-1")?.payload).toEqual(
      expect.objectContaining({ decision: "rejected", rejectionReason: "holdout_replay_error" })
    );
  });
});

function inputFixture() {
  return {
    opportunity: opportunityFixture(),
    parent: parentFixture(),
    candidateVersion: "1.1.0",
    cutoffAt: now,
    createdAt: now,
    binding: {
      skillId: "baidu-application",
      version: "1.1.0",
      site: "baidu" as const,
      pageFingerprintHash: fingerprint,
      allocationId: "allocation-1"
    }
  };
}

function opportunityFixture(): EvolutionOpportunity {
  return {
    opportunityId: "evolution-opportunity-1",
    scope: { site: "baidu", pageFingerprintHash: fingerprint, skillId: "baidu-application", version: "1.0.0" },
    theme: { pageVariantId: "application-form", semantic: "basics.name", errorClass: "field_missing" },
    triggers: ["repeated_actionable_failure"],
    occurrenceCount: 3,
    evidenceRecordIds: ["record-1", "record-2", "record-3"],
    executionChain: [],
    aggregate: undefined
  };
}

function trainingCorpus() {
  return {
    snapshotForEvolution: () => ({
      manifestId: "replay-manifest-1",
      cutoffAt: now,
      trainingCount: 1,
      training: { list: () => [{ sampleId: "train-1", partition: "training" }] as never, get: () => undefined }
    })
  };
}

function holdoutSamples(): RedactedReplaySample[] {
  return ["holdout-1", "holdout-2"].map((sampleId) => ({
    sampleId,
    capturedAt: now,
    site: "baidu",
    pageFingerprintHash: fingerprint,
    scenarioClass: "stable",
    controls: [],
    expectedSemantics: ["basics.name"],
    observedOutcome: {
      pageVariantId: "application-form",
      fieldOutcomes: [],
      auditMismatchClasses: [],
      counts: { verified: 0, observed: 0, planned: 0, auditMismatches: 0, userCorrections: 0 },
      terminalResult: "failed",
      retries: 0,
      recoveries: 0,
      durationMs: 1,
      firstError: { stage: "resolve", semantic: "basics.name", errorClass: "field_missing" }
    },
    partition: "holdout"
  })) as RedactedReplaySample[];
}

function replayRunner(regression: boolean): OfflineReplayRunner {
  return {
    evaluate: async ({ skill, samples }) => samples.map((sample) => ({
      sampleId: sample.sampleId,
      evaluation: evaluation(
        `${skill.version.replaceAll(".", "-")}-${sample.sampleId}`,
        skill.status === "candidate" && !regression ? passingVector() : failingVector()
      )
    }))
  };
}

function evaluation(id: string, vector: ReturnType<typeof passingVector>): SkillEvaluation {
  return {
    evaluationId: `evaluation-${id}`,
    executionRecordId: `execution-${id}`,
    evaluatorVersion: "1.0.0",
    source: "replay",
    ...vector,
    decision: vector.safetyViolations === 0 && vector.incorrectWrites === 0 ? "pass" : "fail",
    evaluatedAt: now
  };
}

function passingVector() {
  return { safetyViolations: 0, incorrectWrites: 0, fieldAccuracy: 1, requiredCompletion: 1,
    userCorrections: 0, retries: 0, recoveries: 0, durationMs: 10 };
}

function failingVector() {
  return { safetyViolations: 0, incorrectWrites: 1, fieldAccuracy: 0.5, requiredCompletion: 0,
    userCorrections: 0, retries: 1, recoveries: 0, durationMs: 20 };
}

function parentFixture(): ApplicationSkillVersion {
  const content = parentContent();
  return {
    skillId: "baidu-application",
    version: "1.0.0",
    schemaVersion: 1,
    contentHash: canonicalSkillContentHash(content),
    site: "baidu",
    allowedDomains: ["talent.baidu.com"],
    pageFingerprintRule: { ruleId: "baidu-form", ruleHash: createHash("sha256").update("baidu-form").digest("hex") },
    status: "champion",
    content,
    createdBy: { kind: "manual_seed", actorId: "skill-author" },
    createdAt: "2026-09-06T00:00:00.000Z"
  };
}

function parentContent(): ApplicationSkillContent {
  return {
    capabilities: ["observe", "fill_empty_fields", "readback", "full_page_audit"],
    pageVariants: [{
      id: "application-form",
      match: { routePatterns: ["/jobs/**/apply"], requiredTexts: ["申请职位"], requiredFields: ["basics.name"] },
      workflowEntry: "fill-form"
    }],
    fields: [{ semantic: "basics.name", controlTypes: ["text"], locatorHints: [{ key: "name", by: "label", text: "姓名" }] }],
    workflow: [{
      id: "fill-form",
      actions: [{ capability: "observe" }, { capability: "fill_empty_fields", semantics: ["basics.name"] },
        { capability: "readback", semantics: ["basics.name"] }, { capability: "full_page_audit" }],
      success: ["page_observed", "writes_read_back", "audit_clean"],
      next: "continue_or_wait"
    }],
    recovery: { maxRetries: 1, actions: ["reobserve"] }
  };
}

function candidateContent(): ApplicationSkillContent {
  const content = structuredClone(parentContent());
  content.fields[0]!.locatorHints.push({ key: "candidate-name", by: "placeholder", text: "请输入姓名" });
  return content;
}

class MemoryRegistry implements EvolutionCoordinatorRegistry {
  readonly versions = new Map<string, ApplicationSkillVersion>();
  readonly runs = new Map<string, SkillEvolutionRunRecord>();
  readonly bindings: SkillBinding[] = [];
  allocation = {
    allocationId: "allocation-1",
    skillId: "baidu-application",
    site: "baidu" as const,
    pageFingerprintHash: fingerprint,
    championVersion: "1.0.0",
    championPercent: 100,
    challengerPercent: 0,
    updatedAt: now
  };

  constructor(parent: ApplicationSkillVersion) { this.versions.set(parent.version, structuredClone(parent)); }
  createVersion(input: ApplicationSkillVersion) { this.versions.set(input.version, structuredClone(input)); return { created: true, version: input.version }; }
  getVersion(_skillId: string, version: string) { return this.versions.get(version); }
  bindPage(input: SkillBinding) { this.bindings.push(structuredClone(input)); }
  getPageAllocation() { return structuredClone(this.allocation); }
  compareAndSetStatus(_key: never, expected: ApplicationSkillVersion["status"], next: ApplicationSkillVersion["status"], version: string) {
    const current = this.versions.get(version);
    if (current?.status !== expected) return false;
    this.versions.set(version, { ...current, status: next });
    return true;
  }
  appendEvolutionRun(input: SkillEvolutionRunRecord) {
    if (this.runs.has(input.runId)) throw new Error("UNIQUE constraint failed");
    this.runs.set(input.runId, structuredClone(input));
  }
  getEvolutionRun(runId: string) { return this.runs.get(runId); }
}
