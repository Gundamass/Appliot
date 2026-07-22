import type { ModelProvider, StructuredGenerationInput } from "./provider.js";

export class FakeModelProvider implements ModelProvider {
  private readonly structuredResponse: unknown;
  private readonly embeddings: number[][];

  constructor(structuredResponse: unknown, embeddings: number[][] = []) {
    this.structuredResponse = structuredClone(structuredResponse);
    this.embeddings = structuredClone(embeddings);
  }

  async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
    return input.schema.parse(structuredClone(this.structuredResponse));
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((_, index) => structuredClone(this.embeddings[index] ?? []));
  }
}
