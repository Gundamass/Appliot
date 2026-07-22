import type { ModelProvider, StructuredGenerationInput } from "./provider.js";

export class FakeModelProvider implements ModelProvider {
  constructor(private readonly structuredResponse: unknown, private readonly embeddings: number[][] = []) {}

  async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
    return input.schema.parse(this.structuredResponse);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((_, index) => this.embeddings[index] ?? []);
  }
}
