import { randomUUID } from "node:crypto";
import { ProfileFactSchema, type ProfileFact } from "@resume/contracts";
import { listExtractableFieldPathTemplates } from "@resume/form-semantics";
import type { StructuredModelProvider } from "@resume/model-provider";
import type { ExtractedDocument, ExtractedPage } from "../pdf/types.js";
import { ExtractionSchema, type ExtractionOutput } from "./extraction-schema.js";

export const EXTRACTION_RULES = [
  "Extract only facts explicitly supported by the supplied pages.",
  "Each fact must quote exact evidence from one referenced page.",
  "Do not infer or add unsupported claims.",
  "Scan the entire resume and cover every explicitly present section: basics, education, internship and work experience, projects, skills, certificates, links, self-evaluation, job preferences, campus practice, awards, and publications.",
  "Do not stop after extracting basic or education fields.",
  `Use only these canonical field paths when the value is present: ${listExtractableFieldPathTemplates().map(formatExtractionTemplate).join(", ")}`,
  "Treat internships as work entries. Put the exact role shown by the resume in work[index].title, including the internship wording when present, for example Java backend internship. Use work[index].employmentType only for the generic category such as internship or full-time, never as a substitute for the role.",
  "Emit separate leaf facts for distinct values and use stable zero-based indexes for repeated education, work, project, skill, certificate, campus, award, and publication entries."
].join(" ");

const EXTRACTION_JSON_EXAMPLE = {
  facts: [
    {
      fieldPath: "basics.email",
      value: "candidate@example.com",
      page: 1,
      quote: "candidate@example.com",
      confidence: 0.99
    },
    {
      fieldPath: "education[0].school",
      value: "Example University",
      page: 1,
      quote: "Example University",
      confidence: 0.98
    },
    {
      fieldPath: "work[0].company",
      value: "Example Corp",
      page: 1,
      quote: "Example Corp",
      confidence: 0.98
    },
    {
      fieldPath: "work[0].title",
      value: "Java Backend Internship",
      page: 1,
      quote: "Java Backend Internship",
      confidence: 0.98
    },
    {
      fieldPath: "work[0].employmentType",
      value: "internship",
      page: 1,
      quote: "Internship Experience",
      confidence: 0.95
    },
    {
      fieldPath: "work[0].highlights[0]",
      value: "Reduced API latency by 80%",
      page: 1,
      quote: "Reduced API latency by 80%",
      confidence: 0.97
    },
    {
      fieldPath: "projects[0].name",
      value: "ApplyPilot",
      page: 1,
      quote: "ApplyPilot",
      confidence: 0.98
    },
    {
      fieldPath: "projects[0].highlights[0]",
      value: "Built evidence-backed resume extraction",
      page: 1,
      quote: "Built evidence-backed resume extraction",
      confidence: 0.97
    },
    {
      fieldPath: "skills[0]",
      value: "TypeScript",
      page: 1,
      quote: "TypeScript",
      confidence: 0.98
    },
    {
      fieldPath: "certificates[0].name",
      value: "Example Certificate",
      page: 1,
      quote: "Example Certificate",
      confidence: 0.96
    },
    {
      fieldPath: "links.portfolio",
      value: "https://portfolio.example.com",
      page: 1,
      quote: "https://portfolio.example.com",
      confidence: 0.99
    },
    {
      fieldPath: "self.summary",
      value: "Reliable and evidence-driven",
      page: 1,
      quote: "Reliable and evidence-driven",
      confidence: 0.95
    },
    {
      fieldPath: "preferences.targetRole",
      value: "Software Engineer",
      page: 1,
      quote: "Software Engineer",
      confidence: 0.95
    }
  ]
};

export async function extractFacts(document: ExtractedDocument, provider: StructuredModelProvider): Promise<ProfileFact[]> {
  const pages = indexPages(document.pages);
  const output = ExtractionSchema.parse(await provider.generateStructured({
    system: `${EXTRACTION_RULES} Return the result as json.`,
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

function formatExtractionTemplate(template: string): string {
  return template.replaceAll("[]", "[index]").replaceAll("[0]", "[index]");
}
