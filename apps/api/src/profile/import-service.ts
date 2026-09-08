import { createHash, randomUUID } from "node:crypto";
import { ProfileFactSchema, type ProfileFact } from "@resume/contracts";
import { InvalidPdfDocumentError } from "@resume/profile-domain/src/pdf/extract-pdf.js";
import type { ExtractedDocument } from "@resume/profile-domain/src/pdf/types.js";
import { z } from "zod";
import type { ProfileRepository } from "./profile-repository.js";
import { createDocumentRepository } from "./document-repository.js";
import type { OriginalDocumentStore } from "./original-document-store.js";
import type { SqliteDatabase } from "../db/client.js";

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
  const snapshot = Uint8Array.from(bytes);
  const fingerprint = createHash("sha256").update(snapshot).digest("hex");
  const documents = createDocumentRepository(dependencies.database);
  let retainedDocument = documents.findByFingerprint(fingerprint);

  if (retainedDocument?.importStatus === "completed") throw new DuplicateDocumentError();

  if (!retainedDocument) {
    const retainedOriginal = await dependencies.originalDocumentStore.retain(fingerprint, snapshot);
    try {
      retainedDocument = documents.createRetained({
        id: randomUUID(),
        fingerprint,
        filename,
        sourcePath: retainedOriginal.path,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      retainedDocument = documents.findByFingerprint(fingerprint);
      if (!retainedDocument) {
        await dependencies.originalDocumentStore.discardCreated(retainedOriginal);
        throw new ImportPersistenceError();
      }
    }
  }

  retainedDocument = documents.setCurrent(retainedDocument.id);

  if (retainedDocument.importStatus === "completed" || !documents.claimImport(retainedDocument.id)) {
    throw new DuplicateDocumentError();
  }

  let document: ExtractedDocument;
  try {
    document = ExtractedDocumentSchema.parse(await dependencies.extractPdf(snapshot));
    if (document.fingerprint !== fingerprint) throw new InvalidExtractionOutputError();
  } catch (error) {
    documents.releaseImport(retainedDocument.id);
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
    documents.releaseImport(retainedDocument.id);
    if (error instanceof ProfileImportUnavailableError) throw error;
    if (!(error instanceof z.ZodError) && !(error instanceof InvalidExtractionOutputError)) throw error;
    throw new InvalidExtractionOutputError();
  }

  const imported = ImportedDocumentSchema.parse({ documentId: retainedDocument.id, fingerprint });
  const createdAt = new Date().toISOString();

  try {
    return dependencies.database.transaction(() => {
      const insertChunk = dependencies.database.prepare(
        "INSERT INTO document_chunks (id, document_id, page, content, created_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (const page of document.pages) {
        insertChunk.run(randomUUID(), imported.documentId, page.page, page.text, createdAt);
      }
      for (const fact of facts) dependencies.profileRepository.createExtracted(fact);
      if (!documents.completeCurrentImport(retainedDocument.id)) throw new Error("current_document_changed");

      return imported;
    })();
  } catch (error) {
    documents.releaseImport(retainedDocument.id);
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
