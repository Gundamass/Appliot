import type { z } from "zod";

export type StructuredGenerationPurpose = "adapter_proposal" | "adapter_replay_review" | "self_evaluation";

export interface StructuredGenerationMetadata {
  requestId: string;
  purpose: StructuredGenerationPurpose;
}

export interface StructuredGenerationInput<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  jsonExample: unknown;
  metadata?: StructuredGenerationMetadata;
}

export interface RawStructuredResponse extends StructuredGenerationMetadata {
  model: string;
  content: string;
}

export interface StructuredModelProvider {
  generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T>;
}

export interface EmbeddingProvider {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
