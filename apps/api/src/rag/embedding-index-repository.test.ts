import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createEmbeddingIndexRepository, type EmbeddingIndexConfig, type StoredFactVector } from "./embedding-index-repository.js";

function config(id: string): EmbeddingIndexConfig {
  return { id, model: "qwen", modelRevision: "rev-1", dimensions: 2, normalization: "l2", instructionVersion: "ins-1" };
}

function storedVector(factId: string, value: number): StoredFactVector {
  return { factId, factRevision: 1, contentHash: `hash-${factId}`, vector: [value, value] };
}

function createRepository() {
  const database = new Database(":memory:");
  migrateDatabase(database);
  return { database, repository: createEmbeddingIndexRepository(database) };
}

function seedFact(database: Database.Database, factId: string): void {
  database.prepare(`INSERT INTO profile_facts (id, field_path, value_json, status, confidence, scope, evidence_json, revision, created_at, updated_at)
    VALUES (?, 'x', '"ok"', 'extracted', 1, 'profile', '[{"documentId":"doc","page":1,"text":"x","extraction":"pdf_text"}]', 1, 'now', 'now')`).run(factId);
}

describe("EmbeddingIndexRepository", () => {
  it("keeps the old index active until the replacement is complete", () => {
    const { database, repository } = createRepository();
    seedFact(database, "fact-1");
    const first = repository.beginBuild(config("index-v1"));
    repository.putVectors(first.id, [storedVector("fact-1", 1)]);
    repository.activate(first.id);

    const second = repository.beginBuild(config("index-v2"));
    expect(repository.getActive()?.id).toBe(first.id);
    repository.putVectors(second.id, [storedVector("fact-1", 1)]);
    repository.activate(second.id);

    expect(repository.getActive()?.id).toBe(second.id);
    expect(repository.getById(first.id)?.status).toBe("retired");
    database.close();
  });

  it("does not expose an interrupted building index as active", () => {
    const { database, repository } = createRepository();
    seedFact(database, "fact-1");
    const index = repository.beginBuild(config("building"));
    repository.putVectors(index.id, [storedVector("fact-1", 1)]);

    expect(repository.getActive()).toBeUndefined();
    expect(repository.listVectors(index.id)).toHaveLength(1);
    database.close();
  });

  it("rejects vectors with invalid values or dimensions before persistence", () => {
    const { database, repository } = createRepository();
    const index = repository.beginBuild(config("index"));

    expect(() => repository.putVectors(index.id, [{ ...storedVector("bad-dimension", 1), vector: [1] }])).toThrow();
    expect(() => repository.putVectors(index.id, [{ ...storedVector("bad-number", 1), vector: [1, Number.NaN] }])).toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM fact_embeddings").get()).toEqual({ count: 0 });
    database.close();
  });

  it("rejects malformed persisted vectors instead of accepting them", () => {
    const { database, repository } = createRepository();
    const index = repository.beginBuild(config("index"));
    database.prepare(`INSERT INTO profile_facts (id, field_path, value_json, status, confidence, scope, evidence_json, revision, created_at, updated_at)
      VALUES ('fact-1', 'x', '"ok"', 'extracted', 1, 'profile', '[{"documentId":"doc","page":1,"text":"x","extraction":"pdf_text"}]', 1, 'now', 'now')`).run();
    database.prepare(`INSERT INTO fact_embeddings (index_id, fact_id, fact_revision, content_hash, vector_json, created_at)
      VALUES (?, 'fact-1', 1, 'hash', '[1,"not-a-number"]', 'now')`).run(index.id);

    expect(() => repository.listVectors(index.id)).toThrow();
    database.close();
  });

  it("replaces a fact vector and deletes stale facts", () => {
    const { database, repository } = createRepository();
    seedFact(database, "fact-1");
    seedFact(database, "fact-2");
    const index = repository.beginBuild(config("index"));
    repository.putVectors(index.id, [storedVector("fact-1", 1), storedVector("fact-2", 2)]);
    repository.replaceFactVector(index.id, { ...storedVector("fact-1", 3), factRevision: 2 });
    repository.deleteStaleFacts(index.id, ["fact-1"]);

    expect(repository.listVectors(index.id)).toEqual([{ ...storedVector("fact-1", 3), factRevision: 2 }]);
    database.close();
  });
});
