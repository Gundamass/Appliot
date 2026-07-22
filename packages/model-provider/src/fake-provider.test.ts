import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeModelProvider } from "./fake-provider.js";

const ResponseSchema = z.object({
  facts: z.array(z.object({ value: z.array(z.string()) }))
});

describe("FakeModelProvider", () => {
  it("snapshots structured responses and embeddings at construction", async () => {
    const response = { facts: [{ value: ["TypeScript"] }] };
    const embeddings = [[0.1, 0.2]];
    const provider = new FakeModelProvider(response, embeddings);
    response.facts[0]?.value.push("Rust");
    embeddings[0]?.push(0.3);

    await expect(provider.generateStructured({ system: "", user: "", schema: ResponseSchema }))
      .resolves.toEqual({ facts: [{ value: ["TypeScript"] }] });
    await expect(provider.embed(["resume"])).resolves.toEqual([[0.1, 0.2]]);
  });

  it("returns fresh structured responses and embedding matrices", async () => {
    const provider = new FakeModelProvider({ facts: [{ value: ["TypeScript"] }] }, [[0.1, 0.2]]);
    const firstResponse = await provider.generateStructured({ system: "", user: "", schema: ResponseSchema });
    const firstEmbeddings = await provider.embed(["resume"]);
    firstResponse.facts[0]?.value.push("Rust");
    firstEmbeddings[0]?.push(0.3);

    await expect(provider.generateStructured({ system: "", user: "", schema: ResponseSchema }))
      .resolves.toEqual({ facts: [{ value: ["TypeScript"] }] });
    await expect(provider.embed(["resume"])).resolves.toEqual([[0.1, 0.2]]);
  });
});
