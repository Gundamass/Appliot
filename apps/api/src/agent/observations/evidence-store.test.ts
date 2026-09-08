import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../../db/client.js";
import { createInMemoryEvidenceStore, createSqliteEvidenceStore } from "./evidence-store.js";

describe("EvidenceStore", () => {
  it("accepts only evidence registered with action provenance for the same run and step", () => {
    const store = createInMemoryEvidenceStore();
    const evidence = store.register({
      runId: "run-1",
      stepId: "step-1",
      invocationId: "invocation-1",
      kind: "action",
      sourceRef: "browser:observation-1",
      contentHash: "a".repeat(64)
    });

    expect(store.validate(evidence.id, { runId: "run-1", stepId: "step-1" })).toMatchObject({
      valid: true,
      evidence: { id: evidence.id, kind: "action" }
    });
    expect(store.validate(evidence.id, { runId: "run-2", stepId: "step-1" })).toEqual({
      valid: false,
      reason: "evidence_provenance_mismatch"
    });
    expect(store.validate("forged-evidence", { runId: "run-1", stepId: "step-1" })).toEqual({
      valid: false,
      reason: "evidence_not_registered"
    });
  });

  it("does not allow an unbound document reference to satisfy an action step", () => {
    const store = createInMemoryEvidenceStore();
    const document = store.register({
      runId: "run-1",
      stepId: "step-1",
      invocationId: "invocation-1",
      kind: "document",
      sourceRef: "document:resume-1",
      contentHash: "b".repeat(64)
    });

    expect(store.validate(document.id, {
      runId: "run-1",
      stepId: "step-1",
      requiredKind: "action"
    })).toEqual({
      valid: false,
      reason: "evidence_kind_mismatch"
    });
  });

  it("keeps evidence provenance available after the store is recreated", () => {
    const database = createSqliteDatabase(":memory:");
    const first = createSqliteEvidenceStore(database, { now: () => "2026-09-04T00:00:00.000Z" });
    const evidence = first.register({
      runId: "run-persistent",
      stepId: "step-1",
      invocationId: "invocation-1",
      kind: "observation",
      sourceRef: "browser:snapshot-1",
      contentHash: "b".repeat(64)
    });

    const restarted = createSqliteEvidenceStore(database, { now: () => "2026-09-04T00:01:00.000Z" });
    expect(restarted.validate(evidence.id, {
      runId: "run-persistent",
      stepId: "step-1",
      requiredKind: "observation"
    })).toMatchObject({ valid: true, evidence: { id: evidence.id, runId: "run-persistent" } });
    database.close();
  });
});
