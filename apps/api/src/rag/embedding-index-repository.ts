import type { SqliteDatabase } from "../db/client.js";
import { z } from "zod";

const indexConfigSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  modelRevision: z.string().min(1),
  dimensions: z.number().int().positive(),
  normalization: z.literal("l2"),
  instructionVersion: z.string().min(1)
}).strict();

const indexSchema = indexConfigSchema.extend({
  status: z.enum(["building", "active", "retired"]),
  createdAt: z.string().min(1),
  activatedAt: z.string().min(1).nullable()
}).strict();

export type EmbeddingIndexConfig = z.infer<typeof indexConfigSchema>;
export type EmbeddingIndex = z.infer<typeof indexSchema>;

export interface StoredFactVector {
  factId: string;
  factRevision: number;
  contentHash: string;
  vector: number[];
}

interface IndexRow {
  id: string;
  model: string;
  model_revision: string;
  dimensions: number;
  normalization: string;
  instruction_version: string;
  status: string;
  created_at: string;
  activated_at: string | null;
}

interface VectorRow {
  index_id: string;
  fact_id: string;
  fact_revision: number;
  content_hash: string;
  vector_json: string;
}

function now(): string {
  return new Date().toISOString();
}

function parseIndex(row: IndexRow): EmbeddingIndex {
  return indexSchema.parse({
    id: row.id,
    model: row.model,
    modelRevision: row.model_revision,
    dimensions: row.dimensions,
    normalization: row.normalization,
    instructionVersion: row.instruction_version,
    status: row.status,
    createdAt: row.created_at,
    activatedAt: row.activated_at
  });
}

function vectorSchema(dimensions: number) {
  return z.object({
    factId: z.string().min(1),
    factRevision: z.number().int().positive(),
    contentHash: z.string().min(1),
    vector: z.array(z.number().finite()).length(dimensions)
  }).strict();
}

function parseVector(row: VectorRow, dimensions: number): StoredFactVector {
  let vector: unknown;
  try {
    vector = JSON.parse(row.vector_json);
  } catch {
    throw new Error(`invalid persisted embedding vector for index ${row.index_id}`);
  }
  return vectorSchema(dimensions).parse({
    factId: row.fact_id,
    factRevision: row.fact_revision,
    contentHash: row.content_hash,
    vector
  });
}

function validateVector(input: StoredFactVector, dimensions: number): StoredFactVector {
  return vectorSchema(dimensions).parse(input);
}

export interface EmbeddingIndexRepository {
  beginBuild(config: EmbeddingIndexConfig): EmbeddingIndex;
  putVectors(indexId: string, vectors: StoredFactVector[]): void;
  activate(indexId: string): EmbeddingIndex;
  getActive(): EmbeddingIndex | undefined;
  getById(indexId: string): EmbeddingIndex | undefined;
  listVectors(indexId: string): StoredFactVector[];
  replaceFactVector(indexId: string, vector: StoredFactVector): void;
  deleteStaleFacts(indexId: string, retainedFactIds: string[]): void;
}

export function createEmbeddingIndexRepository(database: SqliteDatabase): EmbeddingIndexRepository {
  const getIndexRow = database.prepare("SELECT * FROM embedding_indexes WHERE id = ?");
  const requireBuilding = (indexId: string): { index: EmbeddingIndex; dimensions: number } => {
    const row = getIndexRow.get(indexId) as IndexRow | undefined;
    if (!row) throw new Error(`embedding index not found: ${indexId}`);
    const index = parseIndex(row);
    if (index.status !== "building") throw new Error(`embedding index is not building: ${indexId}`);
    return { index, dimensions: index.dimensions };
  };
  const requireIndex = (indexId: string): EmbeddingIndex => {
    const row = getIndexRow.get(indexId) as IndexRow | undefined;
    if (!row) throw new Error(`embedding index not found: ${indexId}`);
    return parseIndex(row);
  };

  return {
    beginBuild(input) {
      const config = indexConfigSchema.parse(input);
      const createdAt = now();
      database.prepare(`INSERT INTO embedding_indexes
        (id, model, model_revision, dimensions, normalization, instruction_version, status, created_at, activated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'building', ?, NULL)`).run(
        config.id, config.model, config.modelRevision, config.dimensions, config.normalization,
        config.instructionVersion, createdAt
      );
      return parseIndex(getIndexRow.get(config.id) as IndexRow);
    },

    putVectors(indexId, inputs) {
      const { dimensions } = requireBuilding(indexId);
      const vectors = inputs.map((input) => validateVector(input, dimensions));
      const insert = database.prepare(`INSERT INTO fact_embeddings
        (index_id, fact_id, fact_revision, content_hash, vector_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(index_id, fact_id) DO UPDATE SET
          fact_revision = excluded.fact_revision, content_hash = excluded.content_hash,
          vector_json = excluded.vector_json, created_at = excluded.created_at`);
      database.transaction(() => {
        for (const vector of vectors) insert.run(indexId, vector.factId, vector.factRevision, vector.contentHash, JSON.stringify(vector.vector), now());
      })();
    },

    activate(indexId) {
      requireBuilding(indexId);
      const activatedAt = now();
      database.transaction(() => {
        database.prepare("UPDATE embedding_indexes SET status = 'retired' WHERE status = 'active'").run();
        database.prepare("UPDATE embedding_indexes SET status = 'active', activated_at = ? WHERE id = ? AND status = 'building'").run(activatedAt, indexId);
      })();
      return requireIndex(indexId);
    },

    getActive() {
      const row = database.prepare("SELECT * FROM embedding_indexes WHERE status = 'active'").get() as IndexRow | undefined;
      return row ? parseIndex(row) : undefined;
    },

    getById(indexId) {
      const row = getIndexRow.get(indexId) as IndexRow | undefined;
      return row ? parseIndex(row) : undefined;
    },

    listVectors(indexId) {
      const index = requireIndex(indexId);
      const rows = database.prepare("SELECT * FROM fact_embeddings WHERE index_id = ? ORDER BY fact_id").all(indexId) as VectorRow[];
      return rows.map((row) => parseVector(row, index.dimensions));
    },

    replaceFactVector(indexId, input) {
      const { dimensions } = requireBuilding(indexId);
      const vector = validateVector(input, dimensions);
      database.prepare(`INSERT INTO fact_embeddings
        (index_id, fact_id, fact_revision, content_hash, vector_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(index_id, fact_id) DO UPDATE SET
          fact_revision = excluded.fact_revision, content_hash = excluded.content_hash,
          vector_json = excluded.vector_json, created_at = excluded.created_at`).run(
        indexId, vector.factId, vector.factRevision, vector.contentHash, JSON.stringify(vector.vector), now()
      );
    },

    deleteStaleFacts(indexId, retainedFactIds) {
      requireBuilding(indexId);
      const deleteAll = database.prepare("DELETE FROM fact_embeddings WHERE index_id = ?");
      if (retainedFactIds.length === 0) {
        deleteAll.run(indexId);
        return;
      }
      const placeholders = retainedFactIds.map(() => "?").join(", ");
      database.prepare(`DELETE FROM fact_embeddings WHERE index_id = ? AND fact_id NOT IN (${placeholders})`).run(indexId, ...retainedFactIds);
    }
  };
}
