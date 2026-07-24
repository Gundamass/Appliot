import Database from "better-sqlite3";
import type { StructuredGenerationInput, StructuredModelProvider } from "@resume/model-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createApp, type AppDependencies } from "../app.js";
import type { OriginalDocumentStore } from "../profile/original-document-store.js";
import { createProfileRepository } from "../profile/profile-repository.js";
import { createSelfEvaluationReviewRepository } from "./review-repository.js";

const resources: Array<{ app: Awaited<ReturnType<typeof createApp>>; database: InstanceType<typeof Database> }> = [];
const originalDocumentStore = {
  async retain() { throw new Error("uploads are not used by review route tests"); },
  async discardCreated() {}
} satisfies OriginalDocumentStore;

const generatedDraft = {
  draft: "Original self-evaluation with React",
  reasons: ["React emphasis"],
  claims: [{ text: "Original self-evaluation with React", kind: "evidence" as const, evidenceFactIds: ["react"] }]
};

function providerReturning(output: unknown = generatedDraft): StructuredModelProvider {
  return {
    async generateStructured<T>() { return output as T; }
  };
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    resource.database.close();
  }
});

async function testApp() {
  const database = new Database(":memory:");
  migrateDatabase(database);
  const profileRepository = createProfileRepository(database);
  profileRepository.createExtracted({
    id: "self-evaluation", fieldPath: "selfEvaluation", value: "Original self-evaluation", status: "extracted", confidence: 1,
    scope: "profile", evidence: [{ documentId: "resume", page: 1, text: "Original self-evaluation", extraction: "pdf_text" }], revision: 1
  });
  profileRepository.confirm("self-evaluation");
  profileRepository.createExtracted({
    id: "react", fieldPath: "skills", value: "React", status: "extracted", confidence: 1,
    scope: "profile", evidence: [{ documentId: "user", page: 1, text: "Confirmed React", extraction: "user" }], revision: 1
  });
  profileRepository.confirm("react");
  const dependencies: AppDependencies = {
    database, adapterHealth: {}, profileRepository,
    originalDocumentStore,
    selfEvaluationModelProvider: providerReturning(),
    extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }),
    extractFacts: async () => []
  };
  const app = await createApp(dependencies);
  resources.push({ app, database });
  return { app, profileRepository };
}

const draft = {
  taskId: "task-1", jobDescription: "React role", original: "Original self-evaluation", draft: "Original self-evaluation with React", reasons: ["React emphasis"],
  evidence: [{ documentId: "user", page: 1, text: "Confirmed React", extraction: "user" }], unsupportedClaims: [], status: "needs_review"
};

const submission = {
  jobDescription: "React role"
};

describe("self-evaluation review routes", () => {
  it("uses the persisted job description and only same-task answers in server-side tailoring", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const profileRepository = createProfileRepository(database);
    profileRepository.createExtracted({ id: "self", fieldPath: "selfEvaluation", value: "Original", status: "extracted", confidence: 1, scope: "profile", evidence: [{ documentId: "resume", page: 1, text: "Original", extraction: "pdf_text" }], revision: 1 });
    profileRepository.confirm("self");
    profileRepository.putTaskAnswer("task-1", "preferences.city", "Shenzhen", [{ documentId: "user", page: 1, text: "Shenzhen", extraction: "user" }]);
    profileRepository.putTaskAnswer("task-2", "preferences.city", "Beijing", [{ documentId: "user", page: 1, text: "Beijing", extraction: "user" }]);
    let providerInput = "";
    const provider: StructuredModelProvider = {
      async generateStructured<T>(input: StructuredGenerationInput<T>) {
        providerInput = input.user;
        return {
          draft: "Original",
          reasons: ["Reviewed against the role"],
          claims: []
        } as T;
      }
    };
    const app = await createApp({
      database,
      profileRepository,
      originalDocumentStore,
      selfEvaluationModelProvider: provider,
      extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }),
      extractFacts: async () => []
    });
    resources.push({ app, database });

    const response = await app.inject({
      method: "POST",
      url: "/api/reviews/self-evaluations/task-1",
      payload: { jobDescription: "React role in Shenzhen" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ jobDescription: "React role in Shenzhen", draft: "Original" });
    expect(providerInput).toContain("React role in Shenzhen");
    expect(providerInput).toContain("Shenzhen");
    expect(providerInput).not.toContain("Beijing");

    const loaded = await app.inject({ method: "GET", url: "/api/reviews/self-evaluations/task-1" });
    expect(loaded.json()).toMatchObject({ jobDescription: "React role in Shenzhen" });
  });
  it("binds a created review to server-owned base provenance and rejects client originals", async () => {
    const { app } = await testApp();
    const created = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: submission });
    const forgedBase = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-2", payload: {
      ...submission, original: "Rust engineer"
    } });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ original: "Original self-evaluation", status: "needs_review" });
    expect(forgedBase.statusCode).toBe(400);
  });

  it("fails creation without an eligible reviewed profile self-evaluation", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const app = await createApp({ database, profileRepository: createProfileRepository(database), originalDocumentStore, extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }), extractFacts: async () => [] });
    resources.push({ app, database });

    const response = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: submission });

    expect(response.statusCode).toBe(409);
  });

  it("does not use extracted, superseded, or cross-task self-evaluation facts as a base", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const profileRepository = createProfileRepository(database);
    profileRepository.createExtracted({ id: "extracted-base", fieldPath: "selfEvaluation", value: "Extracted base", status: "extracted", confidence: 1, scope: "profile", evidence: [{ documentId: "resume", page: 1, text: "Extracted base", extraction: "pdf_text" }], revision: 1 });
    profileRepository.createExtracted({ id: "cross-task-base", fieldPath: "selfEvaluation", value: "Cross task base", status: "extracted", confidence: 1, scope: "application", taskId: "task-2", evidence: [{ documentId: "user", page: 1, text: "Cross task base", extraction: "user" }], revision: 1 });
    profileRepository.confirm("cross-task-base");
    profileRepository.createExtracted({ id: "superseded-base", fieldPath: "selfEvaluation", value: "Superseded base", status: "extracted", confidence: 1, scope: "profile", evidence: [{ documentId: "resume", page: 1, text: "Superseded base", extraction: "pdf_text" }], revision: 1 });
    profileRepository.confirm("superseded-base");
    profileRepository.createExtracted({ id: "non-string-current", fieldPath: "selfEvaluation", value: { invalid: true }, status: "extracted", confidence: 1, scope: "profile", evidence: [{ documentId: "user", page: 1, text: "Corrected elsewhere", extraction: "user" }], revision: 1 });
    profileRepository.confirm("non-string-current");
    const app = await createApp({ database, profileRepository, originalDocumentStore, selfEvaluationModelProvider: providerReturning({ draft: "PMP certified.", reasons: ["Match."], claims: [{ text: "PMP", kind: "evidence", evidenceFactIds: ["pmp"] }] }), extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }), extractFacts: async () => [] });
    resources.push({ app, database });

    const response = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: submission });

    expect(response.statusCode).toBe(409);
  });

  it("revalidates a created draft against the server-bound original polarity", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const profileRepository = createProfileRepository(database);
    profileRepository.createExtracted({ id: "self-evaluation", fieldPath: "selfEvaluation", value: "Not PMP certified.", status: "extracted", confidence: 1, scope: "profile", evidence: [{ documentId: "resume", page: 1, text: "Not PMP certified.", extraction: "pdf_text" }], revision: 1 });
    profileRepository.confirm("self-evaluation");
    profileRepository.createExtracted({ id: "pmp", fieldPath: "certificates", value: "PMP", status: "extracted", confidence: 1, scope: "profile", evidence: [{ documentId: "user", page: 1, text: "PMP token only", extraction: "user" }], revision: 1 });
    profileRepository.confirm("pmp");
    const app = await createApp({ database, profileRepository, originalDocumentStore, selfEvaluationModelProvider: providerReturning({ draft: "PMP certified.", reasons: ["Match."], claims: [{ text: "PMP", kind: "evidence", evidenceFactIds: ["pmp"] }] }), extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }), extractFacts: async () => [] });
    resources.push({ app, database });

    const response = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: { jobDescription: "role" } });

    expect(response.statusCode).toBe(400);
  });

  it("rejects an edited relationship swap without changing the task answer or review state", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const profileRepository = createProfileRepository(database);
    profileRepository.createExtracted({ id: "self-evaluation", fieldPath: "selfEvaluation", value: "3 years React. 5 years Java.", status: "extracted", confidence: 1, scope: "profile", evidence: [{ documentId: "resume", page: 1, text: "3 years React. 5 years Java.", extraction: "pdf_text" }], revision: 1 });
    profileRepository.confirm("self-evaluation");
    const app = await createApp({ database, profileRepository, originalDocumentStore, selfEvaluationModelProvider: providerReturning({ draft: "3 years React. 5 years Java.", reasons: ["Review."], claims: [] }), extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }), extractFacts: async () => [] });
    resources.push({ app, database });
    const create = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: { jobDescription: "role" } });

    const approval = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/approve", payload: { editedDraft: "5 years React. 3 years Java." } });
    const stored = await app.inject({ method: "GET", url: "/api/reviews/self-evaluations/task-1" });

    expect(create.statusCode).toBe(201);
    expect(approval.statusCode).toBe(409);
    expect(stored.json()).toMatchObject({ status: "needs_review", draft: "3 years React. 5 years Java." });
    expect(profileRepository.resolveForTask("task-1", "selfEvaluation")?.value).toBe("3 years React. 5 years Java.");
  });

  it("rolls back approval after the review state write fails to persist the task answer", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const profileRepository = createProfileRepository(database);
    profileRepository.createExtracted({ id: "self-evaluation", fieldPath: "selfEvaluation", value: "Original self-evaluation", status: "extracted", confidence: 1, scope: "profile", evidence: [{ documentId: "resume", page: 1, text: "Original self-evaluation", extraction: "pdf_text" }], revision: 1 });
    profileRepository.confirm("self-evaluation");
    profileRepository.createExtracted({ id: "react", fieldPath: "skills", value: "React", status: "extracted", confidence: 1, scope: "profile", evidence: [{ documentId: "user", page: 1, text: "Confirmed React", extraction: "user" }], revision: 1 });
    profileRepository.confirm("react");
    const originalPut = profileRepository.putTaskAnswer.bind(profileRepository);
    let fail = true;
    profileRepository.putTaskAnswer = ((...args) => { if (fail) throw new Error("after review transition"); return originalPut(...args); }) as typeof profileRepository.putTaskAnswer;
    const reviewRepository = createSelfEvaluationReviewRepository(database);
    const app = await createApp({ database, profileRepository, originalDocumentStore, reviewRepository, selfEvaluationModelProvider: providerReturning(), extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }), extractFacts: async () => [] });
    resources.push({ app, database });
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: submission });

    expect((await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/approve", payload: {} })).statusCode).toBe(409);
    expect(reviewRepository.get("task-1")?.status).toBe("needs_review");
    fail = false;
    expect((await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/approve", payload: {} })).statusCode).toBe(200);
  });

  it("binds promotion to the saved base id and revision without a caller target", async () => {
    const { app, profileRepository } = await testApp();
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: submission });
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/approve", payload: {} });
    profileRepository.correct("self-evaluation", "New base", [{ documentId: "user", page: 1, text: "New base", extraction: "user" }]);

    const stale = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/promote", payload: {} });

    expect(stale.statusCode).toBe(409);
  });

  it("rolls back promotion when its terminal state write fails, then permits a retry", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const profileRepository = createProfileRepository(database);
    profileRepository.createExtracted({ id: "self-evaluation", fieldPath: "selfEvaluation", value: "Original self-evaluation", status: "extracted", confidence: 1, scope: "profile", evidence: [{ documentId: "resume", page: 1, text: "Original self-evaluation", extraction: "pdf_text" }], revision: 1 });
    profileRepository.confirm("self-evaluation");
    profileRepository.createExtracted({ id: "react", fieldPath: "skills", value: "React", status: "extracted", confidence: 1, scope: "profile", evidence: [{ documentId: "user", page: 1, text: "Confirmed React", extraction: "user" }], revision: 1 });
    profileRepository.confirm("react");
    const reviewRepository = createSelfEvaluationReviewRepository(database);
    const originalMarkPromoted = reviewRepository.markPromoted.bind(reviewRepository);
    let fail = true;
    reviewRepository.markPromoted = ((taskId) => { if (fail) throw new Error("after profile correction"); return originalMarkPromoted(taskId); }) as typeof reviewRepository.markPromoted;
    const app = await createApp({ database, profileRepository, originalDocumentStore, reviewRepository, selfEvaluationModelProvider: providerReturning(), extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }), extractFacts: async () => [] });
    resources.push({ app, database });
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: submission });
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/approve", payload: {} });

    expect((await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/promote", payload: {} })).statusCode).toBe(409);
    expect(profileRepository.getById("self-evaluation")?.value).toBe("Original self-evaluation");
    expect(profileRepository.getById("self-evaluation")?.revision).toBe(1);
    expect(reviewRepository.get("task-1")?.status).toBe("approved");
    fail = false;
    expect((await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/promote", payload: {} })).statusCode).toBe(200);
  });

  it("allows only one concurrent approval and one concurrent promotion", async () => {
    const { app } = await testApp();
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: submission });

    const approvals = await Promise.all([
      app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/approve", payload: {} }),
      app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/approve", payload: {} })
    ]);
    expect(approvals.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    const promotions = await Promise.all([
      app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/promote", payload: {} }),
      app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/promote", payload: {} })
    ]);
    expect(promotions.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });
  it("approves task-only without mutating the profile", async () => {
    const { app, profileRepository } = await testApp();
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: submission });
    const response = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/approve", payload: {} });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ taskId: "task-1", status: "approved" });
    expect(profileRepository.resolveForTask("task-1", "selfEvaluation")?.value).toBe("Original self-evaluation with React");
    expect(profileRepository.resolveForTask("task-2", "selfEvaluation")?.value).toBe("Original self-evaluation");
    expect(profileRepository.listActive().find((fact) => fact.id === "self-evaluation")?.value).toBe("Original self-evaluation");
  });

  it("rejects caller-supplied drafts and malformed bodies", async () => {
    const { app } = await testApp();
    const forged = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: { ...submission, draft: { ...generatedDraft, draft: "Original self-evaluation with Rust", claims: [{ text: "Rust", kind: "evidence", evidenceFactIds: ["react"] }] } } });
    const blocked = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: {
      draft: { ...generatedDraft, draft: "Rust", claims: [] }
    } });
    const malformed = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: { ...submission, extra: true } });
    const unsupported = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: { ...submission, draft: { ...generatedDraft, draft: "Original self-evaluation with Rust", claims: [] } } });

    expect(forged.statusCode).toBe(400);
    expect(blocked.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(unsupported.statusCode).toBe(400);
  });

  it("promotes only a previously approved draft to the explicit self-evaluation profile target", async () => {
    const { app, profileRepository } = await testApp();
    const beforeApproval = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/promote", payload: {} });
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: submission });
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/approve", payload: {} });
    const wrongTarget = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/promote", payload: { profileFactId: "wrong" } });
    const promoted = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/promote", payload: {} });
    const doublePromotion = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/promote", payload: {} });

    expect(beforeApproval.statusCode).toBe(409);
    expect(wrongTarget.statusCode).toBe(400);
    expect(promoted.statusCode).toBe(200);
    expect(profileRepository.listActive().find((fact) => fact.id === "self-evaluation")?.value).toBe("Original self-evaluation with React");
    expect(doublePromotion.statusCode).toBe(409);
  });

  it("does not let a new draft overwrite an approved review", async () => {
    const { app } = await testApp();
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: submission });
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/approve", payload: {} });

    const overwrite = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: submission });

    expect(overwrite.statusCode).toBe(409);
  });
});
