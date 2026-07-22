import { randomUUID } from "node:crypto";
import type { ProfileFact } from "@resume/contracts";
import type { ExtractedDocument } from "@resume/profile-domain/src/pdf/types.js";
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

export interface ImportedDocument {
  documentId: string;
  fingerprint: string;
}

export async function importProfileDocument(
  dependencies: ProfileImportDependencies,
  filename: string,
  bytes: Uint8Array
): Promise<ImportedDocument> {
  let document: ExtractedDocument;

  try {
    document = await dependencies.extractPdf(bytes);
  } catch {
    throw new InvalidPdfError();
  }

  let facts: ProfileFact[];
  try {
    facts = await dependencies.extractFacts(document);
  } catch {
    throw new ProfileImportUnavailableError();
  }

  const documentId = randomUUID();
  const createdAt = new Date().toISOString();

  try {
    return dependencies.database.transaction(() => {
      dependencies.database.prepare(
        "INSERT INTO documents (id, fingerprint, filename, created_at) VALUES (?, ?, ?, ?)"
      ).run(documentId, document.fingerprint, filename, createdAt);

      const insertChunk = dependencies.database.prepare(
        "INSERT INTO document_chunks (id, document_id, page, content, created_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (const page of document.pages) {
        insertChunk.run(randomUUID(), documentId, page.page, page.text, createdAt);
      }
      for (const fact of facts) dependencies.profileRepository.createExtracted(fact);

      return { documentId, fingerprint: document.fingerprint };
    })();
  } catch (error) {
    if (isDuplicateFingerprintError(error)) throw new DuplicateDocumentError();
    throw new ProfileImportUnavailableError();
  }
}

function isDuplicateFingerprintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: documents\.fingerprint/.test(error.message);
}
