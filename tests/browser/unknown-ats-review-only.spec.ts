import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { StructuredGenerationInput, StructuredModelProvider } from "../../packages/model-provider/src/provider.js";
import { ActionPolicy } from "../../packages/action-policy/src/index.js";
import type { HintPackDefinition, FormField } from "../../packages/contracts/src/index.js";
import { createHintPackRegistry } from "../../packages/form-semantics/src/hint-packs/registry.js";
import { createApplicationService } from "../../apps/api/src/applications/application-service.js";
import { createCheckpointRepository } from "../../apps/api/src/applications/checkpoint-repository.js";
import { createAdapterLedger } from "../../apps/api/src/ats-adapters/adapter-ledger.js";
import { createAdapterReviewService } from "../../apps/api/src/ats-adapters/adapter-review-service.js";
import { createAiProposalService } from "../../apps/api/src/ats-adapters/ai-proposal-service.js";
import { SyntheticReplayRunner } from "../../apps/api/src/ats-adapters/synthetic-replay-runner.js";
import { createSqliteDatabase } from "../../apps/api/src/db/client.js";
import { migrateDatabase } from "../../apps/api/src/db/migrate.js";
import { BrowserSessionManager } from "../../apps/browser-worker/src/session-manager.js";
import { startSyntheticAts } from "../../apps/synthetic-ats/src/server.js";

test("unknown ATS remains review-only until a human-certified pack is resolvable", async () => {
  const taskId = randomUUID();
  const replayValues = {
    "basics.name": "MARKER_candidate_name",
    "education[0].institution": "MARKER_example_university"
  } as const;
  const profileDir = await mkdtemp(join(tmpdir(), "resume-unknown-ats-e2e-"));
  const synthetic = await startSyntheticAts();
  const database = createSqliteDatabase(":memory:");
  migrateDatabase(database);
  const ledger = createAdapterLedger(database);
  const proposalDefinition = definition();
  const provider: StructuredModelProvider = {
    async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
      return input.schema.parse(proposalDefinition);
    }
  };
  const proposalService = createAiProposalService({
    provider,
    ledger,
    providerName: "test-provider",
    model: "test-model"
  });
  const reviewService = createAdapterReviewService({
    ledger,
    aiProposalService: proposalService,
    replayRunner: new SyntheticReplayRunner({ startSyntheticAts }),
    listProfilePaths: () => ["basics.name", "education[0].institution"],
    reviewer: "local-user"
  });
  const registry = createHintPackRegistry({
    builtIns: [],
    local: () => ledger.listCertified(),
    isRetired: (packId, version) => ledger.isRetired(packId, version)
  });
  const approvalKey = Buffer.alloc(32, 71);
  const policy = new ActionPolicy(approvalKey);
  const browser = new BrowserSessionManager({ profileDir, headless: true });
  const resolvedFieldDiagnostics: Array<{
    fieldId: string;
    semanticHint: string | undefined;
    semanticSource: string | undefined;
  }> = [];
  const commandDiagnostics: Array<{
    type: string;
    fieldId: string | undefined;
    status: string;
  }> = [];
  const applicationUrl = `${synthetic.baseUrl}/adapter-replay/adapter-replay-basic?taskId=${encodeURIComponent(taskId)}`;
  const service = createApplicationService({
    checkpoints: createCheckpointRepository(database),
    browser: {
      observe: (id) => browser.observe(id),
      execute: async (command, epoch) => {
        const result = await browser.execute(command, epoch);
        commandDiagnostics.push({
          type: command.type,
          fieldId: "fieldId" in command ? command.fieldId : undefined,
          status: result.status
        });
        return result;
      },
      invalidateExecution: (id, epoch) => browser.invalidateExecution(id, epoch)
    },
    hintPackRegistry: registry,
    adapterReviewService: reviewService,
    resolveField: async (_id, field: FormField) => {
      resolvedFieldDiagnostics.push({
        fieldId: field.id,
        semanticHint: field.semanticHint,
        semanticSource: field.semanticSource
      });
      const semanticHint = field.semanticHint;
      const value = semanticHint === undefined ? undefined : replayValues[semanticHint as keyof typeof replayValues];
      return value === undefined || semanticHint === undefined
        ? { status: "needs_question" as const, question: `Missing ${field.label}` }
        : { status: "verified" as const, value, fieldPath: semanticHint };
    },
    approve: (request, snapshot) => policy.approve(request, snapshot, { valid: snapshot.errors.length === 0 }).token
  });

  try {
    await browser.start(approvalKey.toString("base64url"));
    await browser.open(taskId, applicationUrl);
    service.start({ taskId, applicationUrl });
    await service.runUntilPause(taskId);

    expect(service.state(taskId).value).toBe("awaiting_adapter_review");
    expect(service.adapterReview(taskId)?.proposal).toBeDefined();
    expect(service.adapterReview(taskId)?.writeBlocked).toBe(true);
    expect(synthetic.state(taskId).runtime.writeCounts).toEqual({});
    expect(synthetic.state(taskId).submissionCount).toBe(0);

    const proposalId = service.adapterReview(taskId)?.proposal?.proposalId;
    if (proposalId === undefined) throw new Error("adapter_proposal_missing");
    const replay = await reviewService.replay(proposalId);
    expect(replay.lifecycleStatus).toBe("replay_verified");
    const aiReview = await reviewService.requestAiReview(proposalId);
    expect(aiReview.aiReviewUnavailable).toBe(true);
    const certified = reviewService.decide(proposalId, {
      decision: "certify",
      aiReviewUnavailable: true,
      acknowledgedAiUnavailable: true
    });
    expect(certified.lifecycleStatus).toBe("certified");

    await service.resumeAfterAdapterCertification(taskId);

    expect(service.state(taskId).value).toBe("review_locked");
    expect(resolvedFieldDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ semanticHint: "basics.name", semanticSource: "certified_hint" }),
      expect.objectContaining({ semanticHint: "education[0].institution", semanticSource: "certified_hint" })
    ]));
    expect(commandDiagnostics).toEqual([
      expect.objectContaining({ type: "fill", fieldId: expect.any(String), status: "applied" }),
      expect.objectContaining({ type: "fill", fieldId: expect.any(String), status: "applied" })
    ]);
    await expect.poll(
      () => synthetic.state(taskId).runtime.values,
      { timeout: 2_000, intervals: [25, 50, 100] }
    ).toMatchObject({
      name: replayValues["basics.name"],
      school: replayValues["education[0].institution"],
      unrelatedSentinel: "UNCHANGED"
    });
    expect(synthetic.state(taskId).runtime.writeCounts.unrelatedSentinel ?? 0).toBe(0);
    expect(synthetic.state(taskId).submissionCount).toBe(0);
  } finally {
    await browser.stop();
    await synthetic.close();
    database.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

function definition(): HintPackDefinition {
  return {
    schemaVersion: 1,
    packId: "unknown-synthetic",
    version: "1.0.0",
    match: {
      sites: [{ hostSuffix: "127.0.0.1", pathPrefixes: ["/adapter-replay"] }],
      stages: ["application_form"],
      requiredTextSignals: [],
      pageFingerprintHashes: []
    },
    sectionRules: [],
    fieldRules: [
      {
        ruleId: "full-name",
        profilePath: "basics.name",
        labelAliases: ["Full name"],
        sections: [],
        controlTypes: ["text"],
        confidence: 1
      },
      {
        ruleId: "school",
        profilePath: "education[0].institution",
        labelAliases: ["School"],
        sections: [],
        controlTypes: ["text"],
        confidence: 1
      }
    ],
    actionRules: [],
    fixtures: [{
      fixtureId: "adapter-replay-basic",
      expectedProfilePaths: ["basics.name", "education[0].institution"]
    }]
  };
}
