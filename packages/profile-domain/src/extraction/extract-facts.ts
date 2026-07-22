import { randomUUID } from "node:crypto";
import { ProfileFactSchema, type ProfileFact } from "@resume/contracts";
import type { ModelProvider } from "@resume/model-provider";
import type { ExtractedDocument, ExtractedPage } from "../pdf/types.js";
import { ExtractionSchema, type ExtractionOutput } from "./extraction-schema.js";

export const EXTRACTION_RULES = [
  "Extract only facts explicitly supported by the supplied pages.",
  "Each fact must quote exact evidence from one referenced page.",
  "Do not infer or add unsupported claims."
].join(" ");

export async function extractFacts(document: ExtractedDocument, provider: ModelProvider): Promise<ProfileFact[]> {
  const output = ExtractionSchema.parse(await provider.generateStructured({
    system: EXTRACTION_RULES,
    user: serializePages(document.pages),
    schema: ExtractionSchema
  }));

  return output.facts.map((candidate) => createFact(document, candidate));
}

function createFact(document: ExtractedDocument, candidate: ExtractionOutputFact): ProfileFact {
  const page = document.pages.find((item) => item.page === candidate.page);
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

function serializePages(pages: ExtractedPage[]): string {
  return JSON.stringify(pages.map(({ page, text, source }) => ({ page, text, source })));
}
