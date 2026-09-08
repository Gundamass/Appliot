import { createHash, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/client.js";
import { createDocumentRepository, type RetainedDocument } from "./document-repository.js";
import type { OriginalDocumentStore } from "./original-document-store.js";

export class ImportPersistenceError extends Error {}

export interface CurrentDocumentDependencies {
  database: SqliteDatabase;
  originalDocumentStore: OriginalDocumentStore;
}

export async function retainCurrentProfileDocument(
  dependencies: CurrentDocumentDependencies,
  filename: string,
  bytes: Uint8Array
): Promise<RetainedDocument> {
  const snapshot = Uint8Array.from(bytes);
  const fingerprint = createHash("sha256").update(snapshot).digest("hex");
  const documents = createDocumentRepository(dependencies.database);
  const existing = documents.findByFingerprint(fingerprint);
  if (existing !== undefined) return documents.setCurrent(existing.id);

  const original = await dependencies.originalDocumentStore.retain(fingerprint, snapshot);
  try {
    const document = documents.createRetained({
      id: randomUUID(),
      fingerprint,
      filename,
      sourcePath: original.path,
      createdAt: new Date().toISOString()
    });
    return documents.setCurrent(document.id);
  } catch {
    const raced = documents.findByFingerprint(fingerprint);
    if (raced !== undefined) return documents.setCurrent(raced.id);
    await dependencies.originalDocumentStore.discardCreated(original);
    throw new ImportPersistenceError();
  }
}
