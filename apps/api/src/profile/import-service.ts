import { randomUUID } from "node:crypto";
import { ProfileFactSchema, type ProfileFact } from "@resume/contracts";
import type { ExtractedDocument } from "@resume/profile-domain/src/pdf/types.js";
import { z } from "zod";
import type { ProfileRepository } from "./profile-repository.js";
import type { SqliteDatabase } from "../db/client.js";

export const MAX_PDF_BYTES = 15 * 1024 * 1024;

export interface ProfileImportDependencies {
  database: SqliteDatabase;
  profileRepository: ProfileRepository;
  extractPdf(bytes: Uint8Array): Promise<ExtractedDocument>;
  extractFacts(document: ExtractedDocument): Promise<ProfileFact[]>;
}

export class DuplicateDocumentError extends Error {}
export class InvalidPdfError extends Error {}
export class ProfileImportUnavailableError extends Error {}
export class InvalidExtractionOutputError extends Error {}
export class ImportPersistenceError extends Error {}

export interface ImportedDocument {
  documentId: string;
  fingerprint: string;
}

const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ExtractedPageSchema = z.object({
  page: z.number().int().positive(),
  text: z.string(),
  source: z.enum(["pdf_text", "ocr"])
}).strict();
const ExtractedDocumentSchema = z.object({
  fingerprint: FingerprintSchema,
  pages: z.array(ExtractedPageSchema).min(1)
}).strict().superRefine((document, context) => {
  const pages = new Set<number>();
  for (const page of document.pages) {
    if (pages.has(page.page)) {
      context.addIssue({ code: "custom", message: "duplicate page number", path: ["pages"] });
    }
    pages.add(page.page);
  }
});
const ExtractedFactSchema = ProfileFactSchema.superRefine((fact, context) => {
  if (fact.status !== "extracted") context.addIssue({ code: "custom", message: "fact must be extracted" });
  if (fact.scope !== "profile") context.addIssue({ code: "custom", message: "fact must be profile scoped" });
  if (fact.revision !== 1) context.addIssue({ code: "custom", message: "extracted fact must start at revision 1" });
});
export const ImportedDocumentSchema = z.object({
  documentId: z.string().uuid(),
  fingerprint: FingerprintSchema
}).strict();

export async function importProfileDocument(
  dependencies: ProfileImportDependencies,
  filename: string,
  bytes: Uint8Array
): Promise<ImportedDocument> {
  let document: ExtractedDocument;
  try {
    document = ExtractedDocumentSchema.parse(await dependencies.extractPdf(bytes));
  } catch (error) {
    if (error instanceof InvalidPdfError || error instanceof ProfileImportUnavailableError) throw error;
    if (error instanceof z.ZodError) throw new InvalidExtractionOutputError();
    throw error;
  }

  let facts: ProfileFact[];
  try {
    facts = z.array(ExtractedFactSchema).parse(await dependencies.extractFacts(document));
    validateFactEvidence(document, facts);
  } catch (error) {
    if (error instanceof ProfileImportUnavailableError) throw error;
    if (!(error instanceof z.ZodError) && !(error instanceof InvalidExtractionOutputError)) throw error;
    throw new InvalidExtractionOutputError();
  }

  const imported = ImportedDocumentSchema.parse({
    documentId: randomUUID(),
    fingerprint: document.fingerprint
  });
  const createdAt = new Date().toISOString();

  try {
    return dependencies.database.transaction(() => {
      dependencies.database.prepare(
        "INSERT INTO documents (id, fingerprint, filename, created_at) VALUES (?, ?, ?, ?)"
      ).run(imported.documentId, imported.fingerprint, filename, createdAt);

      const insertChunk = dependencies.database.prepare(
        "INSERT INTO document_chunks (id, document_id, page, content, created_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (const page of document.pages) {
        insertChunk.run(randomUUID(), imported.documentId, page.page, page.text, createdAt);
      }
      for (const fact of facts) dependencies.profileRepository.createExtracted(fact);

      return imported;
    })();
  } catch (error) {
    if (isDuplicateFingerprintError(error)) throw new DuplicateDocumentError();
    throw new ImportPersistenceError();
  }
}

function validateFactEvidence(document: ExtractedDocument, facts: ProfileFact[]): void {
  const pages = new Map(document.pages.map((page) => [page.page, page]));
  for (const fact of facts) {
    for (const evidence of fact.evidence) {
      const page = pages.get(evidence.page);
      if (
        evidence.documentId !== document.fingerprint ||
        page?.source !== evidence.extraction ||
        !page.text.includes(evidence.text)
      ) {
        throw new InvalidExtractionOutputError();
      }
    }
  }
}

function isDuplicateFingerprintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: documents\.fingerprint/.test(error.message);
}
