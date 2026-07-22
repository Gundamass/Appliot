import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { FakeModelProvider } from "@resume/model-provider";
import type { ModelProvider } from "@resume/model-provider";
import { extractFacts } from "./extract-facts.js";
import type { ExtractedDocument } from "../pdf/types.js";

describe("extractFacts", () => {
  it("returns an extracted profile fact with exact page evidence", async () => {
    const provider = new FakeModelProvider({
      facts: [{ fieldPath: "basics.email", value: "ada@example.com", page: 1, quote: "ada@example.com", confidence: 0.98 }]
    });

    const facts = await extractFacts(documentWithPage("Ada Lovelace\nada@example.com"), provider);

    expect(facts).toEqual([
      expect.objectContaining({
        fieldPath: "basics.email",
        value: "ada@example.com",
        status: "extracted",
        confidence: 0.98,
        scope: "profile",
        revision: 1,
        evidence: [{ documentId: "fingerprint-1", page: 1, text: "ada@example.com", extraction: "pdf_text" }]
      })
    ]);
    expect(facts[0]?.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("rejects a model fact whose quoted evidence is absent from the page", async () => {
    const provider = new FakeModelProvider({
      facts: [{ fieldPath: "skills[0]", value: "Rust", page: 1, quote: "Experienced Rust", confidence: 0.9 }]
    });

    await expect(extractFacts(documentWithPage("Experienced TypeScript"), provider))
      .rejects.toThrow("evidence quote not found on page 1");
  });

  it("rejects a model fact whose evidence page does not exist", async () => {
    const provider = new FakeModelProvider({
      facts: [{ fieldPath: "skills[0]", value: "TypeScript", page: 2, quote: "TypeScript", confidence: 0.9 }]
    });

    await expect(extractFacts(documentWithPage("TypeScript"), provider))
      .rejects.toThrow("evidence quote not found on page 2");
  });

  it("rejects malformed provider output before creating facts", async () => {
    const provider = providerReturning({
      facts: [{ fieldPath: "basics.email", value: "ada@example.com", page: "1", quote: "ada@example.com", confidence: 0.9 }]
    });

    await expect(extractFacts(documentWithPage("ada@example.com"), provider)).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects unsupported claims", async () => {
    const provider = new FakeModelProvider({
      facts: [{ fieldPath: "skills[0]", value: "Kubernetes", page: 1, quote: "Kubernetes", confidence: 0.86 }]
    });

    await expect(extractFacts(documentWithPage("TypeScript"), provider))
      .rejects.toThrow("evidence quote not found on page 1");
  });
});

function documentWithPage(text: string): ExtractedDocument {
  return {
    fingerprint: "fingerprint-1",
    pages: [{ page: 1, text, source: "pdf_text" }]
  };
}

function providerReturning(response: unknown): ModelProvider {
  return {
    async generateStructured<T>(): Promise<T> {
      return response as T;
    },
    async embed(): Promise<number[][]> {
      return [];
    }
  };
}
