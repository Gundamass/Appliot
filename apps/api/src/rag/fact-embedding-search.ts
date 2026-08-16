import { createHash, randomUUID } from "node:crypto";
import { ProfileFactSchema, type JsonValue, type ProfileFact } from "@resume/contracts";
import type { EmbeddingProvider } from "@resume/model-provider";
import { EmbeddingSearchUnavailableError } from "@resume/rag";
import type { SqliteDatabase } from "../db/client.js";
import type { EmbeddingTraceSink } from "../observability/embedding-trace.js";
import type { ProfileRepository } from "../profile/profile-repository.js";
import {
  createEmbeddingIndexRepository,
  type EmbeddingIndex,
  type EmbeddingIndexConfig,
  type StoredFactVector
} from "./embedding-index-repository.js";

export type FactEmbeddingIndexConfig = Omit<EmbeddingIndexConfig, "id">;

export { EmbeddingSearchUnavailableError } from "@resume/rag";

export function factEmbeddingText(fact: ProfileFact): string {
  const evidence = fact.evidence
    .map((item) => `[${item.extraction} page ${item.page}] ${item.text}`)
    .sort();
  return [
    `Field: ${fact.fieldPath}`,
    `Value: ${stableJson(fact.value)}`,
    "Evidence:",
    ...evidence
  ].join("\n");
}

export function createFactEmbeddingSearch(
  database: SqliteDatabase,
  profileRepository: ProfileRepository,
  embeddingProvider: EmbeddingProvider,
  indexConfig: FactEmbeddingIndexConfig,
  traceSink?: EmbeddingTraceSink
) {
  const indexRepository = createEmbeddingIndexRepository(database);
  const inFlightBuilds = new Map<string, Promise<EmbeddingIndex>>();
  validateIndexConfig(indexConfig);

  return {
    async search(input: { query: string; taskId: string; limit: number; jobDescription?: string }) {
      validateSearchInput(input);
      let active: EmbeddingIndex;
      let vectors: StoredFactVector[];
      try {
        active = await synchronize();
        vectors = indexRepository.listVectors(active.id);
      } catch {
        throw new EmbeddingSearchUnavailableError();
      }

      if (vectors.length === 0) return [];

      let queryVector: number[];
      try {
        queryVector = validatedVector(await embeddingProvider.embedQuery(input.query), active.dimensions);
      } catch {
        throw new EmbeddingSearchUnavailableError();
      }

      const visibleFacts = new Map<string, ProfileFact>();
      try {
        for (const fact of profileRepository.listForTask(input.taskId)) {
          const parsed = ProfileFactSchema.parse(fact);
          if (isEligible(parsed) && isVisibleToTask(parsed, input.taskId)) visibleFacts.set(parsed.id, parsed);
        }
      } catch {
        throw new EmbeddingSearchUnavailableError();
      }

      const results: Array<{ fact: ProfileFact; score: number }> = [];
      for (const stored of vectors) {
        const fact = visibleFacts.get(stored.factId);
        if (!fact || fact.revision !== stored.factRevision || contentHash(fact) !== stored.contentHash) continue;
        const score = cosineSimilarity(queryVector, stored.vector);
        if (!Number.isFinite(score)) throw new EmbeddingSearchUnavailableError();
        results.push({ fact, score });
      }
      return results.sort((left, right) => right.score - left.score || left.fact.id.localeCompare(right.fact.id)).slice(0, input.limit);
    }
  };

  async function synchronize(): Promise<EmbeddingIndex> {
    const facts = eligibleFacts(profileRepository.listActive());
    const active = indexRepository.getActive();
    if (!active || !matchesConfig(active, indexConfig)) return singleflightRebuild(facts);

    const existing = indexRepository.listVectors(active.id);
    const byFactId = new Map(existing.map((vector) => [vector.factId, vector]));
    const unchanged: StoredFactVector[] = [];
    const changed: ProfileFact[] = [];
    for (const fact of facts) {
      const stored = byFactId.get(fact.id);
      if (stored && stored.factRevision === fact.revision && stored.contentHash === contentHash(fact)) {
        unchanged.push(stored);
      } else {
        changed.push(fact);
      }
    }
    if (changed.length === 0 && existing.length === facts.length) return active;
    return singleflightRebuild(facts, unchanged, changed);
  }

  function singleflightRebuild(
    facts: ProfileFact[],
    unchanged: StoredFactVector[] = [],
    changed: ProfileFact[] = facts
  ): Promise<EmbeddingIndex> {
    const key = factIndexBuildKey(facts, indexConfig);
    const active = inFlightBuilds.get(key);
    if (active !== undefined) return active;

    const build = rebuild(key, facts, unchanged, changed).finally(() => {
      if (inFlightBuilds.get(key) === build) inFlightBuilds.delete(key);
    });
    inFlightBuilds.set(key, build);
    return build;
  }

  async function rebuild(
    cacheKeyHash: string,
    facts: ProfileFact[],
    unchanged: StoredFactVector[] = [],
    changed: ProfileFact[] = facts
  ): Promise<EmbeddingIndex> {
    let buildingId: string | undefined;
    try {
      const building = indexRepository.beginBuild({ id: randomUUID(), ...indexConfig });
      buildingId = building.id;
      if (unchanged.length > 0) indexRepository.putVectors(building.id, unchanged);
      for (const batch of batches(changed, 32)) {
        const vectors = await embeddingProvider.embedDocuments(batch.map(factEmbeddingText));
        if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error("embedding document count mismatch");
        indexRepository.putVectors(building.id, batch.map((fact, index) => ({
          factId: fact.id,
          factRevision: fact.revision,
          contentHash: contentHash(fact),
          vector: validatedVector(vectors[index], building.dimensions)
        })));
      }
      const stored = indexRepository.listVectors(building.id);
      if (stored.length !== facts.length) throw new Error("embedding index row count mismatch");
      const active = indexRepository.activate(building.id);
      recordBuild(cacheKeyHash, "succeeded");
      return active;
    } catch (error) {
      if (buildingId) discardBuildingIndex(database, buildingId);
      recordBuild(cacheKeyHash, "failed");
      throw error;
    }
  }

  function recordBuild(cacheKeyHash: string, result: "succeeded" | "failed"): void {
    try {
      traceSink?.record({
        operation: "fact_build",
        cacheKeyHash,
        deepSeekUsed: false,
        result
      });
    } catch {
      // Diagnostics must not alter index behavior.
    }
  }
}

function eligibleFacts(facts: ProfileFact[]): ProfileFact[] {
  return facts
    .map((fact) => ProfileFactSchema.parse(fact))
    .filter(isEligible)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function isEligible(fact: ProfileFact): boolean {
  return fact.fieldPath !== "basics.avatar"
    && fact.scope === "profile"
    && (fact.status === "user_confirmed" || fact.status === "user_corrected");
}

function isVisibleToTask(fact: ProfileFact, taskId: string): boolean {
  return fact.scope === "profile" ? fact.taskId === undefined : fact.taskId === taskId;
}

function matchesConfig(index: EmbeddingIndex, config: FactEmbeddingIndexConfig): boolean {
  return index.model === config.model
    && index.modelRevision === config.modelRevision
    && index.dimensions === config.dimensions
    && index.normalization === config.normalization
    && index.instructionVersion === config.instructionVersion;
}

function contentHash(fact: ProfileFact): string {
  return createHash("sha256").update(factEmbeddingText(fact), "utf8").digest("hex");
}

function factIndexBuildKey(
  facts: readonly ProfileFact[],
  config: FactEmbeddingIndexConfig
): string {
  return createHash("sha256").update(JSON.stringify({
    config: {
      model: config.model,
      modelRevision: config.modelRevision,
      dimensions: config.dimensions,
      normalization: config.normalization,
      instructionVersion: config.instructionVersion
    },
    facts: facts.map((fact) => ({
      id: fact.id,
      revision: fact.revision,
      contentHash: contentHash(fact)
    }))
  }), "utf8").digest("hex");
}

function validatedVector(vector: unknown, dimensions: number): number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("embedding vector is malformed");
  }
  const magnitude = scaledMagnitude(vector);
  if (magnitude === 0 || !Number.isFinite(magnitude)) throw new Error("embedding vector has zero magnitude");
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const leftScale = maxAbsolute(left);
  const rightScale = maxAbsolute(right);
  if (leftScale === 0 || rightScale === 0) return Number.NaN;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]! / leftScale;
    const rightValue = right[index]! / rightScale;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function scaledMagnitude(vector: number[]): number {
  const scale = maxAbsolute(vector);
  if (scale === 0) return 0;
  return scale * Math.sqrt(vector.reduce((sum, value) => sum + (value / scale) ** 2, 0));
}

function maxAbsolute(vector: number[]): number {
  let maximum = 0;
  for (const value of vector) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

function discardBuildingIndex(database: SqliteDatabase, indexId: string): void {
  database.transaction(() => {
    database.prepare("DELETE FROM fact_embeddings WHERE index_id = ? AND EXISTS (SELECT 1 FROM embedding_indexes WHERE id = ? AND status = 'building')").run(indexId, indexId);
    database.prepare("DELETE FROM embedding_indexes WHERE id = ? AND status = 'building'").run(indexId);
  })();
}

function validateIndexConfig(config: FactEmbeddingIndexConfig): void {
  if (
    typeof config.model !== "string" || config.model.trim() === ""
    || typeof config.modelRevision !== "string" || config.modelRevision.trim() === ""
    || !Number.isInteger(config.dimensions) || config.dimensions <= 0
    || config.normalization !== "l2"
    || typeof config.instructionVersion !== "string" || config.instructionVersion.trim() === ""
  ) {
    throw new Error("embedding index configuration is invalid");
  }
}

function validateSearchInput(input: { query: string; taskId: string; limit: number; jobDescription?: string }): void {
  if (
    typeof input.query !== "string" || input.query.trim() === ""
    || typeof input.taskId !== "string" || input.taskId.trim() === ""
    || !Number.isInteger(input.limit) || input.limit <= 0
    || (input.jobDescription !== undefined && typeof input.jobDescription !== "string")
  ) {
    throw new EmbeddingSearchUnavailableError();
  }
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
}
