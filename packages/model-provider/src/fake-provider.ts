import type { EmbeddingProvider, StructuredGenerationInput, StructuredModelProvider } from "./provider.js";

export class FakeStructuredModelProvider implements StructuredModelProvider {
  private readonly structuredResponse: unknown;

  constructor(structuredResponse: unknown) {
    this.structuredResponse = structuredClone(structuredResponse);
  }

  async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
    return input.schema.parse(structuredClone(this.structuredResponse));
  }
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  private readonly documentVectors: number[][];
  private readonly queryVector: number[];

  constructor(documentVectors: number[][] = [], queryVector: number[] = []) {
    this.documentVectors = structuredClone(documentVectors);
    this.queryVector = structuredClone(queryVector);
  }

  async embedDocuments(_texts: string[]): Promise<number[][]> {
    return structuredClone(this.documentVectors);
  }

  async embedQuery(_text: string): Promise<number[]> {
    return structuredClone(this.queryVector);
  }
}
