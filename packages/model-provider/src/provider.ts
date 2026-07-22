import type { z } from "zod";

export interface StructuredGenerationInput<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
}

export interface ModelProvider {
  generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T>;
  embed(texts: string[]): Promise<number[][]>;
}
