import type { z } from "zod";

export interface StructuredGenerationInput<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  jsonExample: unknown;
}

export interface StructuredModelProvider {
  generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T>;
}

export interface EmbeddingProvider {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
