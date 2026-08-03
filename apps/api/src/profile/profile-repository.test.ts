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

function createTestProfileRepository(options?: { afterSnapshot?: () => void }) {
  const database = new Database(":memory:");
  migrateDatabase(database);
  return createProfileRepository(database, options);
}

describe("ProfileRepository", () => {
  it("creates a user-corrected fact when a missing field is supplied", () => {
    const repository = createTestProfileRepository();

    const fact = repository.upsertUserFact({
      fieldPath: "preferences.targetCity",
      value: "深圳"
    });

    expect(fact).toMatchObject({
      fieldPath: "preferences.targetCity",
      value: "深圳",
      status: "user_corrected",
      confidence: 1,
      scope: "profile",
      revision: 1
    });
    expect(fact.evidence[0]).toMatchObject({ documentId: "user", extraction: "user" });
  });

  it("updates the reviewed semantic equivalent instead of creating a competing fact", () => {
    const repository = createTestProfileRepository();
    const first = repository.upsertUserFact({ fieldPath: "work[0].title", value: "Java 后端实习" });
    const second = repository.upsertUserFact({ fieldPath: "work[0].position", value: "Java 后端开发实习" });

    expect(second).toMatchObject({
      id: first.id,
      fieldPath: "work[0].title",
      value: "Java 后端开发实习",
      revision: 2
    });
    expect(repository.listActive().filter((fact) =>
      fact.fieldPath === "work[0].title" || fact.fieldPath === "work[0].position"
    )).toHaveLength(1);
  });

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

  it("resolves a reviewed legacy profile path through its canonical semantic", () => {
    const repository = createTestProfileRepository();
    repository.createExtracted(makeFact("Java backend intern", "work[0].title", "work-title"));
    repository.confirm("work-title");

    expect(repository.resolveForTask("task-1", "work[0].position")).toMatchObject({
      id: "work-title",
      fieldPath: "work[0].position",
      value: "Java backend intern"
    });
  });

  it("prefers a task-scoped legacy answer over a canonical profile default", () => {
    const repository = createTestProfileRepository();
    repository.createExtracted(makeFact("Profile position", "work[0].position", "profile-position"));
    repository.confirm("profile-position");
    repository.putTaskAnswer("task-1", "work[0].title", "Task-specific position", userEvidence("Task-specific position"));

    expect(repository.resolveForTask("task-1", "work[0].position")).toMatchObject({
      scope: "application",
      fieldPath: "work[0].position",
      value: "Task-specific position"
    });
  });

  it("replaces an equivalent legacy task answer when the canonical path is saved", () => {
    const repository = createTestProfileRepository();
    repository.putTaskAnswer("task-1", "work[0].title", "Legacy position", userEvidence("Legacy position"));
    repository.putTaskAnswer("task-1", "work[0].position", "Canonical position", userEvidence("Canonical position"));

    expect(repository.resolveForTask("task-1", "work[0].title")).toMatchObject({
      value: "Canonical position",
      fieldPath: "work[0].title"
    });
    expect(repository.listForTask("task-1")
      .filter((fact) => fact.scope === "application")
      .map((fact) => [fact.fieldPath, fact.value]))
      .toEqual([["work[0].position", "Canonical position"]]);
  });

  it("treats canonical and legacy reviewed facts as one semantic slot", () => {
    const repository = createTestProfileRepository();
    repository.createExtracted(makeFact("Legacy position", "work[0].title", "legacy-position"));
    repository.confirm("legacy-position");
    repository.createExtracted(makeFact("Canonical position", "work[0].position", "canonical-position"));
    repository.confirm("canonical-position");

    expect(repository.listActive().map((fact) => [fact.id, fact.fieldPath, fact.value])).toEqual([
      ["canonical-position", "work[0].position", "Canonical position"]
    ]);
    expect(repository.resolveForTask("task-1", "work[0].title")).toMatchObject({
      id: "canonical-position",
      fieldPath: "work[0].title",
      value: "Canonical position"
    });
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
    `).run()).toThrow();
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

  it("rolls back a correction when the database fails after its snapshot", () => {
    const repository = createTestProfileRepository({
      afterSnapshot: () => { throw new Error("simulated database failure"); }
    });
    repository.createExtracted(makeFact("Original"));
    repository.confirm("fact-1");

    expect(() => repository.correct("fact-1", "Replacement", userEvidence("Replacement")))
      .toThrow("simulated database failure");
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

  it("lists task answers only with evidence for their owning task", () => {
    const repository = createTestProfileRepository();
    repository.createExtracted(makeFact("Profile default"));
    repository.confirm("fact-1");
    repository.putTaskAnswer("task-1", "preferences.city", "Shenzhen", userEvidence("Shenzhen"));
    repository.putTaskAnswer("task-2", "preferences.city", "Beijing", userEvidence("Beijing"));

    expect(repository.listForTask("task-1").map((fact) => [fact.scope, fact.taskId, fact.value])).toEqual([
      ["profile", undefined, "Profile default"],
      ["application", "task-1", "Shenzhen"]
    ]);
    expect(repository.listForTask("task-2").map((fact) => fact.value)).toEqual(["Profile default", "Beijing"]);
    expect(repository.listActive()).toHaveLength(1);
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

  it("rejects both invalid scope and task combinations in facts and revisions", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const timestamp = "2026-07-22T00:00:00.000Z";
    const insertFact = database.prepare(`
      INSERT INTO profile_facts (
        id, field_path, value_json, status, confidence, scope, task_id, evidence_json, revision, created_at, updated_at
      ) VALUES (?, 'preferences.city', '"Shanghai"', 'user_confirmed', 1, ?, ?, '[{"documentId":"user","page":1,"text":"Shanghai","extraction":"user"}]', 1, ?, ?)
    `);
    const insertRevision = database.prepare(`
      INSERT INTO fact_revisions (
        id, fact_id, field_path, value_json, status, confidence, scope, task_id, evidence_json, revision, created_at
      ) VALUES (?, 'base-fact', 'preferences.city', '"Shanghai"', 'user_confirmed', 1, ?, ?, '[{"documentId":"user","page":1,"text":"Shanghai","extraction":"user"}]', 1, ?)
    `);

    expect(() => insertFact.run("profile-with-task", "profile", "task-forged", timestamp, timestamp)).toThrow();
    expect(() => insertFact.run("application-without-task", "application", null, timestamp, timestamp)).toThrow();
    expect(() => insertRevision.run("profile-revision-with-task", "profile", "task-forged", timestamp)).toThrow();
    expect(() => insertRevision.run("application-revision-without-task", "application", null, timestamp)).toThrow();
    database.close();
  });
});
