import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Evidence, ProfileFact } from "@resume/contracts";
import { migrateDatabase } from "../db/migrate.js";
import { createProfileRepository } from "./profile-repository.js";

function makeFact(value: string, fieldPath = "preferences.city"): ProfileFact {
  return {
    id: "fact-1",
    fieldPath,
    value,
    status: "extracted",
    confidence: 0.8,
    scope: "profile",
    evidence: [{ documentId: "resume-1", page: 1, text: value, extraction: "pdf_text" }],
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
    repository.createExtracted(makeFact("Unconfirmed", "basics.email"));

    expect(repository.resolveForTask("task-1", "basics.email")).toBeUndefined();
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
});
