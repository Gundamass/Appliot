import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "@resume/model-provider";
import {
  fieldDefinitionText,
  type FieldDefinition
} from "@resume/form-semantics";
import type { EmbeddingTraceSink } from "../observability/embedding-trace.js";

export interface EmbeddingIdentity {
  model: string;
  modelRevision: string;
  instructionVersion: string;
}

export type FieldOntologyVectors = readonly (readonly number[])[];

export function fieldOntologyKey(
  definitions: readonly FieldDefinition[],
  identity: EmbeddingIdentity
): string {
  const canonicalDefinitions = definitions.map(({
    semantic,
    label,
    aliases,
    types,
    sections,
    risk,
    description
  }) => ({
    semantic,
    label,
    aliases: [...aliases],
    types: [...types],
    sections: [...sections],
    risk,
    description
  }));
  const canonicalIdentity = {
    model: identity.model,
    modelRevision: identity.modelRevision,
    instructionVersion: identity.instructionVersion
  };
  return createHash("sha256").update(JSON.stringify({
    identity: canonicalIdentity,
    definitions: canonicalDefinitions
  }), "utf8").digest("hex");
}

export class FieldOntologyIndex {
  private readonly cache = new Map<string, FieldOntologyVectors>();
  private readonly inFlight = new Map<string, Promise<FieldOntologyVectors>>();

  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly traceSink?: EmbeddingTraceSink
  ) {}

  async load(
    definitions: readonly FieldDefinition[],
    identity: EmbeddingIdentity
  ): Promise<FieldOntologyVectors> {
    if (definitions.length === 0) throw new Error("field_ontology_empty");
    const key = fieldOntologyKey(definitions, identity);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const active = this.inFlight.get(key);
    if (active !== undefined) return active;

    const build = this.build(definitions).then(
      (vectors) => {
        this.cache.set(key, vectors);
        this.recordBuild(key, "succeeded");
        return vectors;
      },
      (error: unknown) => {
        this.recordBuild(key, "failed");
        throw error;
      }
    );
    this.inFlight.set(key, build);
    try {
      return await build;
    } finally {
      if (this.inFlight.get(key) === build) this.inFlight.delete(key);
    }
  }

  private async build(definitions: readonly FieldDefinition[]): Promise<FieldOntologyVectors> {
    const vectors = await this.embeddingProvider.embedDocuments(definitions.map(fieldDefinitionText));
    if (!Array.isArray(vectors) || vectors.length !== definitions.length) {
      throw new Error("field_ontology_vector_count_mismatch");
    }
    let dimensions: number | undefined;
    const validated = vectors.map((vector) => {
      if (!Array.isArray(vector)
        || vector.length === 0
        || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error("field_ontology_vector_invalid");
      }
      dimensions ??= vector.length;
      if (vector.length !== dimensions) throw new Error("field_ontology_vector_dimensions_mismatch");
      return Object.freeze([...vector]);
    });
    return Object.freeze(validated);
  }

  private recordBuild(cacheKeyHash: string, result: "succeeded" | "failed"): void {
    try {
      this.traceSink?.record({
        operation: "ontology_build",
        cacheKeyHash,
        deepSeekUsed: false,
        result
      });
    } catch {
      // Diagnostics must not alter index behavior.
    }
  }
}
