import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeEmbeddingProvider, FakeStructuredModelProvider } from "./fake-provider.js";

const ResponseSchema = z.object({
  facts: z.array(z.object({ value: z.array(z.string()) }))
});

describe("split fake providers", () => {
  it("keeps structured and embedding fakes independent", async () => {
    const structured = new FakeStructuredModelProvider({ facts: [{ value: ["TypeScript"] }] });
    const embeddings = new FakeEmbeddingProvider([[0.1, 0.2]], [0.9, 0.1]);

    await expect(structured.generateStructured({
      system: "Return json.",
      user: "resume",
      schema: ResponseSchema,
      jsonExample: { facts: [{ value: ["example"] }] }
    })).resolves.toEqual({ facts: [{ value: ["TypeScript"] }] });
    await expect(embeddings.embedDocuments(["resume"])).resolves.toEqual([[0.1, 0.2]]);
    await expect(embeddings.embedQuery("query")).resolves.toEqual([0.9, 0.1]);
  });

  it("snapshots inputs and returns fresh responses", async () => {
    const response = { facts: [{ value: ["TypeScript"] }] };
    const documentVectors = [[0.1, 0.2]];
    const queryVector = [0.9, 0.1];
    const structured = new FakeStructuredModelProvider(response);
    const embeddings = new FakeEmbeddingProvider(documentVectors, queryVector);
    response.facts[0]?.value.push("Rust");
    documentVectors[0]?.push(0.3);
    queryVector.push(0.3);

    const firstResponse = await structured.generateStructured({
      system: "Return json.",
      user: "resume",
      schema: ResponseSchema,
      jsonExample: { facts: [{ value: ["example"] }] }
    });
    const firstDocuments = await embeddings.embedDocuments(["resume"]);
    const firstQuery = await embeddings.embedQuery("query");
    firstResponse.facts[0]?.value.push("Go");
    firstDocuments[0]?.push(0.4);
    firstQuery.push(0.4);

    await expect(structured.generateStructured({
      system: "Return json.",
      user: "resume",
      schema: ResponseSchema,
      jsonExample: { facts: [{ value: ["example"] }] }
    })).resolves.toEqual({ facts: [{ value: ["TypeScript"] }] });
    await expect(embeddings.embedDocuments(["resume"])).resolves.toEqual([[0.1, 0.2]]);
    await expect(embeddings.embedQuery("query")).resolves.toEqual([0.9, 0.1]);
  });
});
