import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createApp, type AppDependencies } from "../app.js";
import { createProfileRepository } from "../profile/profile-repository.js";

const resources: Array<{ app: Awaited<ReturnType<typeof createApp>>; database: InstanceType<typeof Database> }> = [];

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
    database, profileRepository,
    extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }),
    extractFacts: async () => []
  };
  const app = await createApp(dependencies);
  resources.push({ app, database });
  return { app, profileRepository };
}

const draft = {
  taskId: "task-1", original: "Original self-evaluation", draft: "Original self-evaluation with React", reasons: ["React emphasis"],
  evidence: [{ documentId: "user", page: 1, text: "Confirmed React", extraction: "user" }], unsupportedClaims: [], status: "needs_review"
};

describe("self-evaluation review routes", () => {
  it("approves task-only without mutating the profile", async () => {
    const { app, profileRepository } = await testApp();
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: { draft } });
    const response = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/approve", payload: {} });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ...draft, status: "approved" });
    expect(profileRepository.resolveForTask("task-1", "selfEvaluation")?.value).toBe("Original self-evaluation with React");
    expect(profileRepository.resolveForTask("task-2", "selfEvaluation")?.value).toBe("Original self-evaluation");
    expect(profileRepository.listActive().find((fact) => fact.id === "self-evaluation")?.value).toBe("Original self-evaluation");
  });

  it("rejects forged evidence, blocked drafts, and malformed bodies", async () => {
    const { app } = await testApp();
    const forged = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: {
      draft: { ...draft, evidence: [{ documentId: "forged", page: 1, text: "forged", extraction: "pdf_text" }] }
    } });
    const blocked = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: {
      draft: { ...draft, status: "blocked", unsupportedClaims: ["Rust"] }
    } });
    const malformed = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: { draft, extra: true } });
    const unsupported = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: { draft: { ...draft, draft: "Original self-evaluation with Rust" } } });

    expect(forged.statusCode).toBe(400);
    expect(blocked.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(unsupported.statusCode).toBe(400);
  });

  it("promotes only a previously approved draft to the explicit self-evaluation profile target", async () => {
    const { app, profileRepository } = await testApp();
    const beforeApproval = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/promote", payload: { profileFactId: "self-evaluation" } });
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: { draft } });
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/approve", payload: {} });
    const wrongTarget = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/promote", payload: { profileFactId: "wrong" } });
    const promoted = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/promote", payload: { profileFactId: "self-evaluation" } });
    const doublePromotion = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/promote", payload: { profileFactId: "self-evaluation" } });

    expect(beforeApproval.statusCode).toBe(409);
    expect(wrongTarget.statusCode).toBe(400);
    expect(promoted.statusCode).toBe(200);
    expect(profileRepository.listActive().find((fact) => fact.id === "self-evaluation")?.value).toBe("Original self-evaluation with React");
    expect(doublePromotion.statusCode).toBe(409);
  });

  it("does not let a new draft overwrite an approved review", async () => {
    const { app } = await testApp();
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: { draft } });
    await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1/approve", payload: {} });

    const overwrite = await app.inject({ method: "POST", url: "/api/reviews/self-evaluations/task-1", payload: { draft } });

    expect(overwrite.statusCode).toBe(409);
  });
});
