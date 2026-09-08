import type { SqliteDatabase } from "../db/client.js";

export type DocumentImportStatus = "retained" | "importing" | "completed" | "failed";

export interface RetainedDocument {
  id: string;
  fingerprint: string;
  filename: string;
  sourcePath: string;
  importStatus: DocumentImportStatus;
  isCurrent: boolean;
  createdAt: string;
}

export type NewRetainedDocument = Omit<RetainedDocument, "importStatus" | "isCurrent">;

interface DocumentRow {
  id: string;
  fingerprint: string;
  filename: string;
  source_path: string;
  import_status: DocumentImportStatus;
  is_current: number;
  created_at: string;
}

export interface DocumentRepository {
  createRetained(document: NewRetainedDocument): RetainedDocument;
  findById(documentId: string): RetainedDocument | undefined;
  findByFingerprint(fingerprint: string): RetainedDocument | undefined;
  findPageContent(fingerprint: string, page: number): string | undefined;
  findCurrent(): RetainedDocument | undefined;
  findLatestCompleted(): RetainedDocument | undefined;
  setCurrent(documentId: string): RetainedDocument;
  claimImport(documentId: string): boolean;
  markFailed(documentId: string): void;
  releaseImport(documentId: string): void;
  completeCurrentImport(documentId: string): boolean;
}

export function createDocumentRepository(database: SqliteDatabase): DocumentRepository {
  const find = database.prepare("SELECT * FROM documents WHERE fingerprint = ?");
  const findId = database.prepare("SELECT * FROM documents WHERE id = ?");
  const insert = database.prepare(`
    INSERT INTO documents (id, fingerprint, filename, source_path, import_status, created_at)
    VALUES (?, ?, ?, ?, 'retained', ?)
  `);
  const claim = database.prepare(
    "UPDATE documents SET import_status = 'importing' WHERE id = ? AND is_current = 1 AND import_status IN ('retained', 'failed')"
  );
  const reset = database.prepare(
    "UPDATE documents SET import_status = 'retained' WHERE id = ? AND import_status = 'importing'"
  );
  const fail = database.prepare(
    "UPDATE documents SET import_status = 'failed' WHERE id = ? AND import_status = 'importing'"
  );
  const complete = database.prepare(
    "UPDATE documents SET import_status = 'completed' WHERE id = ? AND is_current = 1 AND import_status = 'importing'"
  );
  const findPage = database.prepare(`
    SELECT chunks.content
    FROM document_chunks AS chunks
    INNER JOIN documents ON documents.id = chunks.document_id
    WHERE documents.fingerprint = ? AND documents.import_status = 'completed' AND chunks.page = ?
  `);
  const findLatestCompleted = database.prepare(`
    SELECT * FROM documents
    WHERE import_status = 'completed'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
  const findCurrent = database.prepare(`
    SELECT * FROM documents
    WHERE is_current = 1
    LIMIT 1
  `);

  const findByFingerprint = (fingerprint: string): RetainedDocument | undefined => {
    const row = find.get(fingerprint) as DocumentRow | undefined;
    return row ? parseDocument(row) : undefined;
  };
  const findById = (documentId: string): RetainedDocument | undefined => {
    const row = findId.get(documentId) as DocumentRow | undefined;
    return row ? parseDocument(row) : undefined;
  };
  const switchCurrent = database.transaction((documentId: string): RetainedDocument => {
    if (findById(documentId) === undefined) throw new Error("document_not_found");
    database.prepare("UPDATE documents SET is_current = 0 WHERE is_current = 1 AND id <> ?").run(documentId);
    database.prepare("UPDATE documents SET is_current = 1 WHERE id = ?").run(documentId);
    return findById(documentId)!;
  });

  return {
    createRetained(document) {
      insert.run(document.id, document.fingerprint, document.filename, document.sourcePath, document.createdAt);
      return findByFingerprint(document.fingerprint)!;
    },
    findById,
    findByFingerprint,
    findPageContent(fingerprint, page) {
      return (findPage.get(fingerprint, page) as { content: string } | undefined)?.content;
    },
    findLatestCompleted() {
      const row = findLatestCompleted.get() as DocumentRow | undefined;
      return row ? parseDocument(row) : undefined;
    },
    findCurrent() {
      const row = findCurrent.get() as DocumentRow | undefined;
      return row ? parseDocument(row) : undefined;
    },
    setCurrent(documentId) {
      return switchCurrent(documentId);
    },
    claimImport(documentId) {
      return claim.run(documentId).changes === 1;
    },
    markFailed(documentId) {
      if (fail.run(documentId).changes !== 1) throw new Error("document import is not claimed");
    },
    releaseImport(documentId) {
      reset.run(documentId);
    },
    completeCurrentImport(documentId) {
      return complete.run(documentId).changes === 1;
    }
  };
}

function parseDocument(row: DocumentRow): RetainedDocument {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    filename: row.filename,
    sourcePath: row.source_path,
    importStatus: row.import_status,
    isCurrent: row.is_current === 1,
    createdAt: row.created_at
  };
}
