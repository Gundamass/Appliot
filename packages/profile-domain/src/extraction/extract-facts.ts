import { randomUUID } from "node:crypto";
import { ProfileFactSchema, type ProfileFact } from "@resume/contracts";
import type { StructuredModelProvider } from "@resume/model-provider";
import type { ExtractedDocument, ExtractedPage } from "../pdf/types.js";
import { ExtractionSchema, type ExtractionOutput } from "./extraction-schema.js";

export const EXTRACTION_RULES = [
  "Extract only facts explicitly supported by the supplied pages.",
  "Each fact must quote exact evidence from one referenced page.",
  "Do not infer or add unsupported claims."
].join(" ");

const EXTRACTION_JSON_EXAMPLE = {
  facts: [{
    fieldPath: "basics.email",
    value: "candidate@example.com",
    page: 1,
    quote: "candidate@example.com",
    confidence: 0.99
  }]
};

export async function extractFacts(document: ExtractedDocument, provider: StructuredModelProvider): Promise<ProfileFact[]> {
  const pages = indexPages(document.pages);
  const output = ExtractionSchema.parse(await provider.generateStructured({
    system: EXTRACTION_RULES,
    user: serializePages(document.pages),
    schema: ExtractionSchema,
    jsonExample: EXTRACTION_JSON_EXAMPLE
  }));

  return output.facts.map((candidate) => createFact(document, pages, candidate));
}

function createFact(
  document: ExtractedDocument,
  pages: ReadonlyMap<number, ExtractedPage>,
  candidate: ExtractionOutputFact
): ProfileFact {
  const page = pages.get(candidate.page);
  if (!page?.text.includes(candidate.quote)) {
    throw new Error(`evidence quote not found on page ${candidate.page}`);
  }

  return ProfileFactSchema.parse({
    id: randomUUID(),
    fieldPath: candidate.fieldPath,
    value: candidate.value,
    status: "extracted",
    confidence: candidate.confidence,
    scope: "profile",
    revision: 1,
    evidence: [{
      documentId: document.fingerprint,
      page: candidate.page,
      text: candidate.quote,
      extraction: page.source
    }]
  });
}

type ExtractionOutputFact = ExtractionOutput["facts"][number];

function indexPages(pages: ExtractedPage[]): ReadonlyMap<number, ExtractedPage> {
  const pagesByNumber = new Map<number, ExtractedPage>();

  for (const page of pages) {
    if (!Number.isInteger(page.page) || page.page <= 0) {
      throw new Error(`invalid document page number: ${page.page}`);
    }
    if (pagesByNumber.has(page.page)) {
      throw new Error(`duplicate document page number: ${page.page}`);
    }
    pagesByNumber.set(page.page, page);
  }

  return pagesByNumber;
}

function serializePages(pages: ExtractedPage[]): string {
  return JSON.stringify(pages.map(({ page, text, source }) => ({ page, text, source })));
}
