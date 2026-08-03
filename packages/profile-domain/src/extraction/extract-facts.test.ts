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

  it("instructs the structured provider to return json", async () => {
    const provider = providerReturning({ facts: [] });

    await extractFacts(documentWithPage("Ada Lovelace"), provider);

    expect(provider.generateStructured).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringContaining("json")
    }));
  });

  it("requires complete resume-section coverage with canonical field paths", async () => {
    const provider = providerReturning({ facts: [] });

    await extractFacts(documentWithPage([
      "实习经历：Example Corp 软件工程实习生",
      "项目经历：ApplyPilot 简历投递助手",
      "技能：TypeScript",
      "自我评价：重视可靠性"
    ].join("\n")), provider);

    const input = provider.generateStructured.mock.calls[0]?.[0];
    expect(input.system).toContain("internship");
    expect(input.system).toContain("projects");
    expect(input.system).toContain("skills");
    expect(input.system).toContain("self-evaluation");
    expect(input.system).toContain("certificates");
    expect(input.system).toContain("links");
    expect(input.system).toContain("job preferences");
    expect(input.system).toContain("Do not stop after extracting basic or education fields");
    expect(input.jsonExample.facts.map((fact: { fieldPath: string }) => fact.fieldPath)).toEqual(expect.arrayContaining([
      "basics.email",
      "education[0].school",
      "work[0].company",
      "work[0].title",
      "work[0].highlights[0]",
      "projects[0].name",
      "projects[0].highlights[0]",
      "skills[0]",
      "certificates[0].name",
      "links.portfolio",
      "self.summary",
      "preferences.targetRole"
    ]));
  });

  it("returns evidence-backed work, project, skill, and self-evaluation facts together", async () => {
    const provider = new FakeStructuredModelProvider({
      facts: [
        { fieldPath: "work[0].company", value: "Example Corp", page: 1, quote: "Example Corp", confidence: 0.98 },
        { fieldPath: "projects[0].name", value: "ApplyPilot", page: 1, quote: "ApplyPilot", confidence: 0.97 },
        { fieldPath: "skills[0]", value: "TypeScript", page: 1, quote: "TypeScript", confidence: 0.96 },
        { fieldPath: "self.summary", value: "重视可靠性", page: 1, quote: "重视可靠性", confidence: 0.95 }
      ]
    });

    const facts = await extractFacts(documentWithPage([
      "实习经历：Example Corp",
      "项目经历：ApplyPilot",
      "技能：TypeScript",
      "自我评价：重视可靠性"
    ].join("\n")), provider);

    expect(facts.map((fact) => fact.fieldPath)).toEqual([
      "work[0].company",
      "projects[0].name",
      "skills[0]",
      "self.summary"
    ]);
    expect(facts.every((fact) => fact.evidence[0]?.page === 1)).toBe(true);
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

function providerReturning(response: unknown): StructuredModelProvider & { generateStructured: ReturnType<typeof vi.fn> } {
  const generateStructured = vi.fn(async () => response);
  return { generateStructured } as unknown as StructuredModelProvider & { generateStructured: ReturnType<typeof vi.fn> };
}

function uncalledProvider(): StructuredModelProvider & { generateStructured: ReturnType<typeof vi.fn> } {
  return {
    generateStructured: vi.fn()
  };
}
