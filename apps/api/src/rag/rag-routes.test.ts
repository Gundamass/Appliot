import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createApp } from "../app.js";
import { createProfileRepository } from "../profile/profile-repository.js";
import { createLocalOriginalDocumentStore } from "../profile/original-document-store.js";

const resources: Array<{ app: Awaited<ReturnType<typeof createApp>>; database: InstanceType<typeof Database>; root: string }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    resource.database.close();
    await rm(resource.root, { recursive: true, force: true });
  }
});

async function context() {
  const database = new Database(":memory:");
  migrateDatabase(database);
  const profileRepository = createProfileRepository(database);
  profileRepository.createExtracted({
    id: "email", fieldPath: "basics.email", value: "ada@example.com", status: "extracted", confidence: 1,
    scope: "profile", evidence: [{ documentId: "resume", page: 1, text: "ada@example.com", extraction: "pdf_text" }], revision: 1
  });
  profileRepository.confirm("email");
  const root = await mkdtemp(join(tmpdir(), "resume-rag-routes-"));
  const app = await createApp({
    database,
    profileRepository,
    originalDocumentStore: createLocalOriginalDocumentStore(root),
    extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }),
    extractFacts: async () => []
  });
  resources.push({ app, database, root });
  return { app, profileRepository };
}

const request = {
  taskId: "task-1",
  fieldId: "email-control",
  semantic: "basics.email",
  label: "Email address",
  type: "text"
};

describe("RAG routes", () => {
  it("exposes planning, retrieved evidence, and the service decision", async () => {
    const { app } = await context();
    const response = await app.inject({ method: "POST", url: "/api/rag/fields/resolve", payload: request });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      request,
      plan: { semantic: "basics.email", requiredSources: ["application", "profile"], valid: true },
      decision: { status: "verified_auto", value: "ada@example.com", evidence: [{ text: "ada@example.com" }] }
    });
  });

  it("creates server-owned task evidence and never leaks the correction to another task", async () => {
    const { app, profileRepository } = await context();
    const response = await app.inject({
      method: "POST",
      url: "/api/rag/fields/answer",
      payload: { ...request, semantic: "preferences.city", fieldId: "city", label: "Preferred city", value: "Shenzhen" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      correction: {
        scope: "application",
        taskId: "task-1",
        value: "Shenzhen",
        evidence: [{ documentId: "user", extraction: "user" }]
      },
      inspection: { decision: { status: "verified_auto", value: "Shenzhen" } }
    });
    expect(profileRepository.resolveForTask("task-2", "preferences.city")).toBeUndefined();
  });

  it("rejects caller-owned evidence and requires explicit profile promotion", async () => {
    const { app, profileRepository } = await context();
    const forged = await app.inject({
      method: "POST",
      url: "/api/rag/fields/answer",
      payload: { ...request, value: "forged@example.com", evidence: [{ documentId: "resume", page: 1, text: "forged@example.com", extraction: "pdf_text" }] }
    });
    const promoted = await app.inject({
      method: "POST",
      url: "/api/rag/fields/answer",
      payload: { ...request, value: "new@example.com", promoteToProfile: true, profileFactId: "email" }
    });

    expect(forged.statusCode).toBe(400);
    expect(promoted.statusCode).toBe(200);
    expect(profileRepository.getById("email")).toMatchObject({ value: "new@example.com", status: "user_corrected", scope: "profile" });
  });
});
