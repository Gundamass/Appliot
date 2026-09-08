import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ProfileFactSchema, type ProfileFact } from "@resume/contracts";
import { InvalidPdfDocumentError } from "@resume/profile-domain/src/pdf/extract-pdf.js";
import type { ExtractedDocument } from "@resume/profile-domain/src/pdf/types.js";
import { z } from "zod";
import type { ProfileRepository } from "./profile-repository.js";
import { createDocumentRepository } from "./document-repository.js";
import type { OriginalDocumentStore } from "./original-document-store.js";
import type { SqliteDatabase } from "../db/client.js";
import {
  ImportPersistenceError,
  retainCurrentProfileDocument
} from "./current-document-service.js";

export const MAX_PDF_BYTES = 15 * 1024 * 1024;

export interface ProfileImportDependencies {
  database: SqliteDatabase;
  profileRepository: ProfileRepository;
  originalDocumentStore: OriginalDocumentStore;
  extractPdf(bytes: Uint8Array): Promise<ExtractedDocument>;
  extractFacts(document: ExtractedDocument): Promise<ProfileFact[]>;
}

export class DuplicateDocumentError extends Error {}
export class InvalidPdfError extends Error {}
export class ProfileImportUnavailableError extends Error {}
export class InvalidExtractionOutputError extends Error {}
export class CurrentDocumentChangedError extends Error {
  constructor() {
    super("current_document_changed");
  }
}
export class DocumentImportInProgressError extends Error {
  constructor() {
    super("document_import_in_progress");
  }
}
export { ImportPersistenceError } from "./current-document-service.js";

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
  const snapshot = Uint8Array.from(bytes);
  const retained = await retainCurrentProfileDocument(dependencies, filename, snapshot);
  return parseCurrentProfileDocument(dependencies, retained.id, snapshot);
}

export async function parseCurrentProfileDocument(
  dependencies: ProfileImportDependencies,
  documentId: string,
  retainedBytes?: Uint8Array
): Promise<ImportedDocument> {
  const documents = createDocumentRepository(dependencies.database);
  const retainedDocument = documents.findById(documentId);
  if (retainedDocument === undefined) throw new Error("document_not_found");
  if (!retainedDocument.isCurrent) throw new CurrentDocumentChangedError();
  const imported = ImportedDocumentSchema.parse({
    documentId: retainedDocument.id,
    fingerprint: retainedDocument.fingerprint
  });
  if (retainedDocument.importStatus === "completed") return imported;
  if (!documents.claimImport(retainedDocument.id)) throw new DocumentImportInProgressError();

  const snapshot = retainedBytes === undefined
    ? Uint8Array.from(await readFile(retainedDocument.sourcePath))
    : Uint8Array.from(retainedBytes);

  let document: ExtractedDocument;
  try {
    document = ExtractedDocumentSchema.parse(await dependencies.extractPdf(snapshot));
    if (document.fingerprint !== retainedDocument.fingerprint) throw new InvalidExtractionOutputError();
  } catch (error) {
    failImportClaim(documents, retainedDocument.id);
    if (error instanceof InvalidPdfError || error instanceof ProfileImportUnavailableError) throw error;
    if (error instanceof InvalidPdfDocumentError) throw new InvalidPdfError();
    if (error instanceof z.ZodError || error instanceof InvalidExtractionOutputError) throw new InvalidExtractionOutputError();
    throw error;
  }

  let facts: ProfileFact[];
  try {
    facts = z.array(ExtractedFactSchema).parse(await dependencies.extractFacts(document));
    validateFactEvidence(document, facts);
  } catch (error) {
    failImportClaim(documents, retainedDocument.id);
    if (error instanceof ProfileImportUnavailableError) throw error;
    if (!(error instanceof z.ZodError) && !(error instanceof InvalidExtractionOutputError)) throw error;
    throw new InvalidExtractionOutputError();
  }

  const createdAt = new Date().toISOString();

  try {
    return dependencies.database.transaction(() => {
      if (!documents.completeCurrentImport(retainedDocument.id)) throw new CurrentDocumentChangedError();
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
    if (error instanceof CurrentDocumentChangedError) {
      documents.releaseImport(retainedDocument.id);
      throw error;
    }
    failImportClaim(documents, retainedDocument.id);
    throw new ImportPersistenceError();
  }
}

function failImportClaim(
  documents: ReturnType<typeof createDocumentRepository>,
  documentId: string
): void {
  if (documents.findCurrent()?.id !== documentId) {
    documents.releaseImport(documentId);
    throw new CurrentDocumentChangedError();
  }
  documents.markFailed(documentId);
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
