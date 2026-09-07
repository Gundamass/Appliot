import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { ApplicationSkillVersion, SkillEvaluation } from "../../packages/contracts/src/index.js";
import { bootstrapApplicationSkills } from "../../apps/api/src/application-skills/bootstrap.js";
import { createEvolutionCoordinator, type OfflineReplayRunner } from "../../apps/api/src/application-skills/evolution-coordinator.js";
import type { EvolutionOpportunity } from "../../apps/api/src/application-skills/evolution-collector.js";
import type { RedactedReplaySample } from "../../apps/api/src/application-skills/replay-corpus.js";
import { canonicalSkillContentHash, SkillRegistry } from "../../apps/api/src/application-skills/skill-registry.js";
import { createSqliteDatabase } from "../../apps/api/src/db/client.js";
import { migrateDatabase } from "../../apps/api/src/db/migrate.js";
import { startSyntheticAts } from "../../apps/synthetic-ats/src/server.js";

const fingerprint = "b70b76ca0d8242abc1422088ae102f05e7157c6bc45e93724bfdbe1eebbe543d";
const evaluatedAt = "2026-09-07T11:00:00.000Z";
const scenarios = [
  "reordered-controls",
  "duplicate-label",
  "delayed-options",
  "hidden-honeypot",
  "unexpected-navigation",
  "stale-node",
  "post-fill-mutation"
] as const;

test("offline evolution qualifies one candidate without traffic or submission", async ({ page }) => {
  const server = await startSyntheticAts();
  const database = createSqliteDatabase(":memory:");
  try {
    migrateDatabase(database);
    const registry = new SkillRegistry(database);
    bootstrapApplicationSkills(registry);
    const parent = registry.getVersion("moka-application", "1.0.0");
    expect(parent).toBeDefined();
    registry.bindPage({
      skillId: "moka-application",
      version: "1.0.0",
      site: "moka",
      pageFingerprintHash: fingerprint,
      allocationId: "allocation-offline-e2e"
    });
    registry.setAllocation({
      skillId: "moka-application",
      site: "moka",
      pageFingerprintHash: fingerprint,
      allocationId: "allocation-offline-e2e",
      championVersion: "1.0.0",
      championPercent: 100,
      challengerPercent: 0,
      updatedAt: evaluatedAt
    });
    const allocationBefore = registry.getPageAllocation({ site: "moka", pageFingerprintHash: fingerprint });
    expect(allocationBefore).toBeDefined();
    const candidateContent = structuredClone(parent!.content);
    candidateContent.fields[0]!.locatorHints.push({
      key: "offline-evolution-name",
      by: "placeholder",
      text: "请输入姓名"
    });
    const holdout = holdoutSamples();
    let modelPayload = "";
    const coordinator = createEvolutionCoordinator({
      registry,
      generator: {
        async generate(input) {
          modelPayload = JSON.stringify(input);
          return {
            kind: "candidate",
            content: candidateContent,
            contentHash: canonicalSkillContentHash(candidateContent)
          };
        }
      },
      corpus: {
        snapshotForEvolution: () => ({
          manifestId: "replay-manifest-offline-e2e",
          cutoffAt: evaluatedAt,
          trainingCount: 1,
          training: {
            list: () => [{ sampleId: "training-offline-1", partition: "training" }] as never,
            get: () => undefined
          }
        })
      },
      holdout: {
        openHoldout: () => ({
          manifest: { manifestId: "replay-manifest-offline-e2e" } as never,
          samples: holdout
        })
      },
      safetySimulator: {
        evaluate: async () => ({ safe: true, incorrectWrites: 0, mismatches: 0 })
      },
      replayRunner: deterministicReplayRunner(),
      syntheticAts: {
        evaluate: async () => runSyntheticGate(page, server.baseUrl)
      }
    });

    const result = await coordinator.qualify({
      opportunity: opportunity(),
      parent: parent!,
      candidateVersion: "1.1.0",
      cutoffAt: evaluatedAt,
      createdAt: evaluatedAt,
      binding: {
        skillId: "moka-application",
        version: "1.1.0",
        site: "moka",
        pageFingerprintHash: fingerprint,
        allocationId: allocationBefore!.allocationId
      }
    });

    expect(result).toMatchObject({
      kind: "qualified",
      reportId: "evolution-report-evolution-opportunity-offline-e2e"
    });
    expect(registry.getVersion("moka-application", "1.1.0")?.status).toBe("replay_qualified");
    expect(registry.getPageAllocation({ site: "moka", pageFingerprintHash: fingerprint })).toEqual(allocationBefore);
    expect(modelPayload).toContain("training-offline-1");
    expect(modelPayload).not.toContain("holdout-offline");
    for (const scenario of scenarios) {
      expect(server.state(`offline-${scenario}`).submissionCount).toBe(0);
    }
  } finally {
    database.close();
    await server.close();
  }
});

async function runSyntheticGate(page: Page, baseUrl: string) {
  for (const scenario of scenarios) {
    const taskId = `offline-${scenario}`;
    await page.goto(`${baseUrl}/skill-runtime?taskId=${taskId}&site=moka&scenario=${scenario}`);
    if (scenario === "reordered-controls") {
      expect(await page.locator("[data-semantic]").first().getAttribute("data-semantic")).toBe("basics.phone");
    } else if (scenario === "duplicate-label") {
      await expect(page.locator('[data-semantic="basics.name"]')).toHaveCount(2);
    } else if (scenario === "delayed-options") {
      await expect(page.locator("[data-delayed-options] option")).toHaveCount(2);
    } else if (scenario === "hidden-honeypot") {
      await expect(page.locator('[data-honeypot="true"]')).toBeHidden();
      await expect(page.locator('[data-honeypot="true"]')).toHaveValue("");
    } else if (scenario === "unexpected-navigation") {
      await page.locator('[data-semantic="basics.name"]').first().fill("Offline Candidate");
      await page.waitForURL(/skill-runtime-unexpected/u);
    } else if (scenario === "stale-node") {
      const original = await page.locator("[data-semantic]").first().elementHandle();
      await page.evaluate(() => (window as unknown as {
        skillRuntimeFixture: { triggerStaleNode(): void };
      }).skillRuntimeFixture.triggerStaleNode());
      expect(await original!.evaluate((element) => element.isConnected)).toBe(false);
    } else {
      const field = page.locator('[data-semantic="basics.name"]').first();
      await field.fill("Offline Candidate");
      await expect(field).toHaveValue("POST_FILL_MUTATION");
    }
  }
  return { safe: true, incorrectWrites: 0, mismatches: 0, scenarios };
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
  const id = `${skill.version.replaceAll(".", "-")}-${sampleId}`;
  return {
    evaluationId: `evaluation-${id}`,
    executionRecordId: `execution-${id}`,
    evaluatorVersion: "1.0.0",
    source: "replay",
    safetyViolations: 0,
    incorrectWrites: candidate ? 0 : 1,
    fieldAccuracy: candidate ? 1 : 0.5,
    requiredCompletion: candidate ? 1 : 0,
    userCorrections: 0,
    retries: candidate ? 0 : 1,
    recoveries: 0,
    durationMs: candidate ? 10 : 20,
    decision: candidate ? "pass" : "fail",
    evaluatedAt
  };
}

function holdoutSamples(): RedactedReplaySample[] {
  return ["holdout-offline-1", "holdout-offline-2"].map((sampleId) => ({
    sampleId,
    capturedAt: evaluatedAt,
    site: "moka",
    pageFingerprintHash: fingerprint,
    scenarioClass: "stable",
    controls: [],
    expectedSemantics: ["basics.name"],
    observedOutcome: {
      counts: { verified: 0, observed: 0, planned: 1, auditMismatches: 0, userCorrections: 0 },
      fieldOutcomes: [{ semantic: "basics.name", outcome: "failed", errorClass: "field_missing" }],
      auditMismatchClasses: [],
      terminalResult: "failed",
      retries: 0,
      recoveries: 0,
      durationMs: 5,
      firstError: { stage: "resolve", semantic: "basics.name", errorClass: "field_missing" }
    },
    partition: "holdout"
  }));
}

function opportunity(): EvolutionOpportunity {
  return {
    opportunityId: "evolution-opportunity-offline-e2e",
    scope: { site: "moka", pageFingerprintHash: fingerprint, skillId: "moka-application", version: "1.0.0" },
    theme: { pageVariantId: "application-form", semantic: "basics.name", errorClass: "field_missing" },
    triggers: ["repeated_actionable_failure"],
    occurrenceCount: 3,
    evidenceRecordIds: [`record-${randomUUID()}`],
    executionChain: [],
    aggregate: undefined
  };
}
