import Database from "better-sqlite3";
import { AdapterReviewSummarySchema, type FormSnapshot } from "@resume/contracts";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createCheckpointRepository } from "./checkpoint-repository.js";

const snapshot: FormSnapshot = {
  id: "snapshot-challenge",
  taskId: "task-challenge",
  url: "https://jobs.example.test/apply",
  title: "Application",
  stage: "application_form",
  frameRef: { documentId: "document-challenge", kind: "main" },
  mutationEpoch: 2,
  boundaries: [],
  challenge: {
    kind: "rate_limited",
    detectedAt: "2026-08-15T00:00:00.000Z",
    reasonCode: "main_document_http_429"
  },
  fields: [],
  actions: [],
  errors: []
};

describe("checkpoint repository challenge persistence", () => {
  it("round-trips an awaiting challenge snapshot", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createCheckpointRepository(database);

    repository.save({
      taskId: snapshot.taskId,
      state: "awaiting_challenge",
      url: snapshot.url,
      stage: snapshot.stage,
      snapshotId: snapshot.id,
      fieldIds: [],
      questions: [],
      snapshot
    });

    expect(repository.latest(snapshot.taskId)).toMatchObject({
      state: "awaiting_challenge",
      snapshot: { challenge: snapshot.challenge }
    });
    database.close();
  });

  it("rejects a persisted snapshot with an invalid challenge diagnostic", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createCheckpointRepository(database);
    repository.save({
      taskId: snapshot.taskId,
      state: "observing",
      url: snapshot.url,
      stage: snapshot.stage,
      snapshotId: snapshot.id,
      fieldIds: [],
      questions: [],
      snapshot: {
        ...snapshot,
        challenge: { ...snapshot.challenge!, kind: "unknown_challenge" }
      } as unknown as FormSnapshot
    });

    expect(() => repository.latest(snapshot.taskId)).toThrow();
    database.close();
  });

  it("round-trips an adapter-review projection with its paused checkpoint", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createCheckpointRepository(database);
    const adapterReview = AdapterReviewSummarySchema.parse({
      proposal: {
        proposalId: "proposal-1",
        taskId: snapshot.taskId,
        lifecycleStatus: "candidate",
        provider: "fixture",
        model: "fixture-model",
        promptVersion: "hint-proposal-v1",
        inputHash: "a".repeat(64),
        outputHash: "b".repeat(64),
        definition: {
          schemaVersion: 1,
          packId: "fixture-ats",
          version: "1.0.0",
          match: {
            sites: [{ hostSuffix: "example.test", pathPrefixes: ["/apply"] }],
            stages: ["application_form"],
            requiredTextSignals: [],
            pageFingerprintHashes: []
          },
          sectionRules: [],
          fieldRules: [],
          actionRules: [],
          fixtures: [{ fixtureId: "fixture-basic", expectedProfilePaths: ["basics.name"] }]
        },
        unsupportedBoundaries: [],
        rejectedActions: [],
        createdAt: "2026-08-17T00:00:00.000Z"
      },
      replayReports: [],
      lifecycleStatus: "candidate",
      aiReviewUnavailable: false,
      writeBlocked: true
    });

    repository.save({
      taskId: snapshot.taskId,
      state: "awaiting_adapter_review",
      url: snapshot.url,
      stage: snapshot.stage,
      snapshotId: snapshot.id,
      fieldIds: [],
      questions: [],
      snapshot,
      adapterReview
    });

    expect(repository.latest(snapshot.taskId)).toMatchObject({
      state: "awaiting_adapter_review",
      adapterReview
    });
    database.close();
  });
});
