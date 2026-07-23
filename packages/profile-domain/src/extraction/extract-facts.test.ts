import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { FakeStructuredModelProvider } from "@resume/model-provider";
import type { StructuredModelProvider } from "@resume/model-provider";
import { extractFacts } from "./extract-facts.js";
import type { ExtractedDocument } from "../pdf/types.js";

describe("extractFacts", () => {
  it("returns an extracted profile fact with exact page evidence", async () => {
    const provider = new FakeStructuredModelProvider({
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
    const provider = new FakeStructuredModelProvider({
      facts: [{ fieldPath: "skills[0]", value: "Rust", page: 1, quote: "Experienced Rust", confidence: 0.9 }]
    });

    await expect(extractFacts(documentWithPage("Experienced TypeScript"), provider))
      .rejects.toThrow("evidence quote not found on page 1");
  });

  it("rejects a model fact whose evidence page does not exist", async () => {
    const provider = new FakeStructuredModelProvider({
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

  it("rejects an empty evidence quote in provider output", async () => {
    const provider = providerReturning({
      facts: [{ fieldPath: "basics.email", value: "ada@example.com", page: 1, quote: "", confidence: 0.9 }]
    });

    await expect(extractFacts(documentWithPage("ada@example.com"), provider)).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects duplicate document page numbers before invoking the provider", async () => {
    const provider = uncalledProvider();
    const document: ExtractedDocument = {
      fingerprint: "fingerprint-1",
      pages: [
        { page: 1, text: "Ada Lovelace", source: "pdf_text" },
        { page: 1, text: "ada@example.com", source: "pdf_text" }
      ]
    };

    await expect(extractFacts(document, provider)).rejects.toThrow("duplicate document page number: 1");
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });

  it("rejects non-positive document page numbers before invoking the provider", async () => {
    const provider = uncalledProvider();
    const document: ExtractedDocument = {
      fingerprint: "fingerprint-1",
      pages: [{ page: 0, text: "Ada Lovelace", source: "pdf_text" }]
    };

    await expect(extractFacts(document, provider)).rejects.toThrow("invalid document page number: 0");
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });

  it("rejects unsupported claims", async () => {
    const provider = new FakeStructuredModelProvider({
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

function providerReturning(response: unknown): StructuredModelProvider {
  return {
    async generateStructured<T>(): Promise<T> {
      return response as T;
    }
  };
}

function uncalledProvider(): StructuredModelProvider & { generateStructured: ReturnType<typeof vi.fn> } {
  return {
    generateStructured: vi.fn()
  };
}
