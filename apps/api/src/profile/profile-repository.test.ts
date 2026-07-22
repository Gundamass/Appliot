import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Evidence, JsonValue, ProfileFact } from "@resume/contracts";
import { migrateDatabase } from "../db/migrate.js";
import { createProfileRepository } from "./profile-repository.js";

function makeFact(value: JsonValue, fieldPath = "preferences.city", id = "fact-1"): ProfileFact {
  return {
    id,
    fieldPath,
    value,
    status: "extracted",
    confidence: 0.8,
    scope: "profile",
    evidence: [{ documentId: "resume-1", page: 1, text: JSON.stringify(value), extraction: "pdf_text" }],
    revision: 1
  };
}

function userEvidence(text: string): Evidence[] {
  return [{ documentId: "user", page: 1, text, extraction: "user" }];
}

function createTestProfileRepository() {
  const database = new Database(":memory:");
  migrateDatabase(database);
  return createProfileRepository(database);
}

describe("ProfileRepository", () => {
  it("keeps revisions and resolves task answers before profile defaults", () => {
    const repository = createTestProfileRepository();
    repository.createExtracted(makeFact("Hangzhou"));
    repository.confirm("fact-1");
    repository.correct("fact-1", "Shanghai", userEvidence("Shanghai"));
    repository.putTaskAnswer("task-1", "preferences.city", "Shenzhen", userEvidence("Shenzhen"));

    expect(repository.resolveForTask("task-1", "preferences.city")?.value).toBe("Shenzhen");
    expect(repository.resolveForTask("task-2", "preferences.city")?.value).toBe("Shanghai");
    expect(repository.history("fact-1")).toHaveLength(2);
  });

  it("does not resolve extracted or superseded profile facts", () => {
    const repository = createTestProfileRepository();
    repository.createExtracted(makeFact("Unconfirmed", "basics.email", "extracted"));
    expect(repository.resolveForTask("task-1", "basics.email")).toBeUndefined();

    repository.createExtracted(makeFact("First", "basics.email", "first"));
    repository.confirm("first");
    repository.createExtracted(makeFact("Second", "basics.email", "second"));
    repository.confirm("second");

    expect(repository.resolveForTask("task-1", "basics.email")).toMatchObject({ id: "second" });
    expect(repository.listActive().map((fact) => fact.id)).not.toContain("first");
  });

  it("enforces task IDs for application-scoped facts at the database boundary", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);

    expect(() => database.prepare(`
      INSERT INTO profile_facts (
        id, field_path, value_json, status, confidence, scope, task_id, evidence_json, revision, created_at, updated_at
      ) VALUES (
        'application-fact', 'preferences.city', '"Shanghai"', 'user_confirmed', 1, 'application', NULL, '[]', 1,
        '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'
      )
    `).run()).toThrow(/CHECK constraint failed/);
  });

  it("supersedes every competing reviewed default when confirming a candidate", () => {
    const repository = createTestProfileRepository();
    repository.createExtracted(makeFact("First", "preferences.city", "first"));
    repository.createExtracted(makeFact("Second", "preferences.city", "second"));
    repository.confirm("first");
    repository.confirm("second");

    expect(repository.resolveForTask("task", "preferences.city")).toMatchObject({ id: "second", value: "Second" });
    expect(repository.listActive().map((fact) => fact.id)).toEqual(["second"]);
    expect(repository.history("first").at(-1)).toMatchObject({ status: "superseded" });
  });

  it("supersedes reviewed defaults when a correction becomes the replacement", () => {
    const repository = createTestProfileRepository();
    repository.createExtracted(makeFact("First", "preferences.city", "first"));
    repository.createExtracted(makeFact("Second", "preferences.city", "second"));
    repository.confirm("first");
    repository.correct("second", "Replacement", userEvidence("Replacement"));

    expect(repository.resolveForTask("task", "preferences.city")).toMatchObject({ id: "second", value: "Replacement" });
    expect(repository.history("first").at(-1)).toMatchObject({ status: "superseded" });
  });

  it("keeps confirmation idempotent without downgrading a correction", () => {
    const repository = createTestProfileRepository();
    repository.createExtracted(makeFact("Original"));
    const confirmed = repository.confirm("fact-1");
    const confirmedAgain = repository.confirm("fact-1");
    const corrected = repository.correct("fact-1", "Corrected", userEvidence("Corrected"));
    const confirmedCorrected = repository.confirm("fact-1");

    expect(confirmedAgain).toEqual(confirmed);
    expect(confirmedCorrected).toEqual(corrected);
    expect(repository.history("fact-1")).toHaveLength(2);
  });

  it("rejects confirming a superseded fact", () => {
    const repository = createTestProfileRepository();
    repository.createExtracted(makeFact("First", "preferences.city", "first"));
    repository.createExtracted(makeFact("Second", "preferences.city", "second"));
    repository.confirm("first");
    repository.confirm("second");

    expect(() => repository.confirm("first")).toThrow("cannot confirm superseded fact: first");
  });

  it("rolls back a correction when its replacement value or evidence is invalid", () => {
    const repository = createTestProfileRepository();
    repository.createExtracted(makeFact("Original"));
    repository.confirm("fact-1");

    expect(() => repository.correct("fact-1", "Invalid", [])).toThrow();
    expect(repository.history("fact-1")).toHaveLength(1);
    expect(repository.resolveForTask("task", "preferences.city")).toMatchObject({ value: "Original", revision: 1 });
  });

  it("preserves each repeated correction as a revision", () => {
    const repository = createTestProfileRepository();
    repository.createExtracted(makeFact("Original"));
    repository.confirm("fact-1");
    repository.correct("fact-1", "First correction", userEvidence("First correction"));
    repository.correct("fact-1", "Second correction", userEvidence("Second correction"));

    expect(repository.history("fact-1").map((fact) => fact.value)).toEqual([
      "Original", "First correction", "Second correction"
    ]);
  });

  it("replaces task answers without leaking them across tasks", () => {
    const repository = createTestProfileRepository();
    repository.createExtracted(makeFact("Profile default"));
    repository.confirm("fact-1");
    repository.putTaskAnswer("task-1", "preferences.city", "First answer", userEvidence("First answer"));
    repository.putTaskAnswer("task-1", "preferences.city", "Replacement", userEvidence("Replacement"));

    expect(repository.resolveForTask("task-1", "preferences.city")).toMatchObject({ value: "Replacement" });
    expect(repository.resolveForTask("task-2", "preferences.city")).toMatchObject({ value: "Profile default" });
  });

  it("round-trips JSON values without lossy serialization", () => {
    const repository = createTestProfileRepository();
    const values: JsonValue[] = ["text", 5, true, null, ["TypeScript", 5], { city: "Shanghai", remote: true }];

    for (const [index, value] of values.entries()) {
      const id = `json-${index}`;
      const fieldPath = `preferences.values.${index}`;
      repository.createExtracted(makeFact(value, fieldPath, id));
      repository.confirm(id);
      expect(repository.resolveForTask("task", fieldPath)?.value).toEqual(value);
    }
  });

  it("rejects empty evidence and malformed JSON at the database boundary", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const insert = database.prepare(`
      INSERT INTO profile_facts (
        id, field_path, value_json, status, confidence, scope, evidence_json, revision, created_at, updated_at
      ) VALUES (?, 'preferences.city', '"Shanghai"', 'extracted', 0.8, 'profile', ?, 1, '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z')
    `);

    expect(() => insert.run("empty-evidence", "[]")).toThrow();
    expect(() => insert.run("malformed-evidence", "not-json")).toThrow();
  });
});
