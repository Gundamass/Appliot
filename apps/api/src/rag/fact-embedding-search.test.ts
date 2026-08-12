import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { Evidence, ProfileFact } from "@resume/contracts";
import type { EmbeddingProvider } from "@resume/model-provider";
import { migrateDatabase } from "../db/migrate.js";
import { createProfileRepository, type ProfileRepository } from "../profile/profile-repository.js";
import { factEmbeddingText, createFactEmbeddingSearch } from "./fact-embedding-search.js";

const indexConfig = {
  model: "Qwen/Qwen3-Embedding-8B",
  modelRevision: "revision-1",
  dimensions: 2,
  normalization: "l2" as const,
  instructionVersion: "resume-fact-query-v1"
};

describe("FactEmbeddingSearch", () => {
  it("never sends avatar asset IDs to the embedding provider", async () => {
    const avatar = confirmedFact("avatar", 1, "avatar-0f8fad5b-d9cb-469f-a165-70867728950e.webp", "basics.avatar");
    const profile = confirmedFact("name", 1, "陈晨", "basics.name");
    const harness = createHarness([avatar, profile]);

    await harness.service.search(searchInput("姓名"));

    expect(harness.provider.embedDocuments).toHaveBeenCalledWith([factEmbeddingText(profile)]);
    expect(activeVectors(harness.database).map((row) => row.fact_id)).toEqual(["name"]);
  });

  it("builds the first index from confirmed facts in deterministic ID order", async () => {
    const harness = createHarness([confirmedFact("b", 1), confirmedFact("a", 1), extractedFact("ignored")]);

    const results = await harness.service.search(searchInput("first"));

    expect(harness.provider.embedDocuments).toHaveBeenCalledWith([textFor("a", 1), textFor("b", 1)]);
    expect(results.map(({ fact }) => fact.id)).toEqual(["a", "b"]);
    expect(indexRows(harness.database)).toMatchObject([{ status: "active", model_revision: "revision-1" }]);
  });

  it("re-embeds only a corrected fact in the active index", async () => {
    const harness = createHarness([confirmedFact("a", 1), confirmedFact("b", 1)]);
    await harness.service.search(searchInput("first"));
    expect(harness.provider.embedDocuments).toHaveBeenCalledWith([textFor("a", 1), textFor("b", 1)]);

    harness.repository.correct("b", "corrected", [userEvidence("corrected")]);
    harness.provider.embedDocuments.mockClear();
    await harness.service.search(searchInput("second"));

    expect(harness.provider.embedDocuments).toHaveBeenCalledWith([textFor("b", 2, "corrected")]);
    expect(activeVectors(harness.database)).toMatchObject([
      { fact_id: "a", fact_revision: 1 },
      { fact_id: "b", fact_revision: 2 }
    ]);
  });

  it("retains the previous active index when an incremental replacement fails", async () => {
    const harness = createHarness([confirmedFact("a", 1), confirmedFact("b", 1)]);
    await harness.service.search(searchInput("first"));
    const activeId = activeIndexId(harness.database);
    harness.repository.correct("b", "corrected", [userEvidence("corrected")]);
    harness.provider.embedDocuments.mockRejectedValueOnce(new Error("offline"));

    await expect(harness.service.search(searchInput("second"))).rejects.toThrow("embedding search unavailable");

    expect(activeIndexId(harness.database)).toBe(activeId);
    expect(indexRows(harness.database).filter((row) => row.status === "building")).toEqual([]);
  });

  it("removes superseded and deleted facts while never indexing extracted-only facts", async () => {
    const harness = createHarness([confirmedFact("old", 1), confirmedFact("keep", 1), extractedFact("ignored")]);
    await harness.service.search(searchInput("first"));
    harness.repository.createExtracted({ ...confirmedFact("replacement", 1, "replacement", "experience.summary.old"), status: "extracted" });
    harness.repository.confirm("replacement");
    harness.database.prepare("DELETE FROM profile_facts WHERE id = 'keep'").run();
    expect(harness.database.prepare("SELECT fact_id FROM fact_embeddings WHERE fact_id = 'keep'").all()).toEqual([]);
    expect(harness.database.prepare("SELECT fact_id FROM fact_revisions WHERE fact_id = 'keep'").all()).toEqual([]);
    harness.provider.embedDocuments.mockClear();

    const results = await harness.service.search(searchInput("second"));

    expect(harness.provider.embedDocuments).toHaveBeenCalledWith([factEmbeddingText(confirmedFact("replacement", 1, "replacement", "experience.summary.old"))]);
    expect(activeVectors(harness.database).map((row) => row.fact_id)).toEqual(["replacement"]);
    expect(results.map(({ fact }) => fact.id)).toEqual(["replacement"]);
  });

  it("does not index or return a task-local answer for another task", async () => {
    const harness = createHarness([confirmedFact("profile", 1)]);
    harness.repository.putTaskAnswer("task-1", "experience.summary", "task-only", [userEvidence("task-only")]);

    const results = await harness.service.search(searchInput("query", "task-2"));

    expect(activeVectors(harness.database).map((row) => row.fact_id)).toEqual(["profile"]);
    expect(results.map(({ fact }) => fact.id)).toEqual(["profile"]);
  });

  it("fully rebuilds when the configured model revision changes", async () => {
    const harness = createHarness([confirmedFact("a", 1), confirmedFact("b", 1)]);
    await harness.service.search(searchInput("first"));
    const next = createFactEmbeddingSearch(
      harness.database,
      harness.repository,
      harness.provider,
      { ...indexConfig, modelRevision: "revision-2" }
    );
    harness.provider.embedDocuments.mockClear();

    await next.search(searchInput("second"));

    expect(harness.provider.embedDocuments).toHaveBeenCalledWith([textFor("a", 1), textFor("b", 1)]);
    expect(indexRows(harness.database).filter((row) => row.status === "active")).toMatchObject([{ model_revision: "revision-2" }]);
  });

  it("sorts equal finite cosine scores by fact ID", async () => {
    const harness = createHarness([confirmedFact("z", 1), confirmedFact("a", 1)], {
      documentVectors: [[1, 0], [1, 0]],
      queryVector: [1, 0]
    });

    const results = await harness.service.search(searchInput("query"));

    expect(results.map(({ fact }) => fact.id)).toEqual(["a", "z"]);
    expect(results[0]?.score).toBe(results[1]?.score);
  });

  it("rejects malformed persisted vectors before use", async () => {
    const harness = createHarness([confirmedFact("a", 1)]);
    await harness.service.search(searchInput("first"));
    harness.database.prepare("UPDATE fact_embeddings SET vector_json = '[1, \"bad\"]'").run();
    harness.provider.embedQuery.mockClear();

    await expect(harness.service.search(searchInput("second"))).rejects.toThrow("embedding search unavailable");
    expect(harness.provider.embedQuery).not.toHaveBeenCalled();
  });

  it("rejects provider failures instead of returning unverified facts", async () => {
    const harness = createHarness([confirmedFact("a", 1)]);
    harness.provider.embedDocuments.mockRejectedValueOnce(new Error("offline"));

    await expect(harness.service.search(searchInput("query"))).rejects.toThrow("embedding search unavailable");
    expect(indexRows(harness.database).filter((row) => row.status === "active")).toEqual([]);
  });
});

function createHarness(
  facts: ProfileFact[],
  vectors: { documentVectors?: number[][]; queryVector?: number[] } = {}
) {
  const database = new Database(":memory:");
  migrateDatabase(database);
  const repository = createProfileRepository(database);
  for (const fact of facts) {
    repository.createExtracted({ ...fact, status: "extracted" });
    if (fact.status !== "extracted") repository.confirm(fact.id);
  }
  const provider = fakeProvider(vectors);
  return {
    database,
    repository,
    provider,
    service: createFactEmbeddingSearch(database, repository, provider, indexConfig)
  };
}

function fakeProvider(vectors: { documentVectors?: number[][]; queryVector?: number[] }): EmbeddingProvider & {
  embedDocuments: ReturnType<typeof vi.fn>;
  embedQuery: ReturnType<typeof vi.fn>;
} {
  return {
    embedDocuments: vi.fn(async (texts: string[]) => structuredClone(vectors.documentVectors ?? texts.map((_text, index) => index % 2 === 0 ? [1, 0] : [0, 1]))),
    embedQuery: vi.fn(async () => structuredClone(vectors.queryVector ?? [1, 0]))
  };
}

function confirmedFact(id: string, revision: number, value = id, fieldPath = `experience.summary.${id}`): ProfileFact {
  return {
    id,
    fieldPath,
    value,
    status: "user_confirmed",
    confidence: 1,
    scope: "profile",
    evidence: [userEvidence(value)],
    revision
  };
}

function extractedFact(id: string): ProfileFact {
  return { ...confirmedFact(id, 1), status: "extracted" };
}

function userEvidence(text: string): Evidence {
  return { documentId: "user", page: 1, text, extraction: "user" };
}

function textFor(id: string, revision: number, value = id): string {
  return factEmbeddingText(confirmedFact(id, revision, value));
}

function searchInput(query: string, taskId = "task-1") {
  return { query, taskId, limit: 20 };
}

function activeIndexId(database: Database.Database): string | undefined {
  return (database.prepare("SELECT id FROM embedding_indexes WHERE status = 'active'").get() as { id: string } | undefined)?.id;
}

function activeVectors(database: Database.Database): Array<{ fact_id: string; fact_revision: number }> {
  return database.prepare(`SELECT fact_id, fact_revision FROM fact_embeddings
    WHERE index_id = (SELECT id FROM embedding_indexes WHERE status = 'active') ORDER BY fact_id`).all() as Array<{ fact_id: string; fact_revision: number }>;
}

function indexRows(database: Database.Database): Array<{ id: string; status: string; model_revision: string }> {
  return database.prepare("SELECT id, status, model_revision FROM embedding_indexes ORDER BY created_at, id").all() as Array<{ id: string; status: string; model_revision: string }>;
}
