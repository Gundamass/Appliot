import type { SqliteDatabase } from "../db/client.js";

export type DocumentImportStatus = "retained" | "importing" | "completed";

export interface RetainedDocument {
  id: string;
  fingerprint: string;
  filename: string;
  sourcePath: string;
  importStatus: DocumentImportStatus;
  createdAt: string;
}

export type NewRetainedDocument = Omit<RetainedDocument, "importStatus">;

interface DocumentRow {
  id: string;
  fingerprint: string;
  filename: string;
  source_path: string;
  import_status: DocumentImportStatus;
  created_at: string;
}

export interface DocumentRepository {
  createRetained(document: NewRetainedDocument): RetainedDocument;
  findByFingerprint(fingerprint: string): RetainedDocument | undefined;
  findPageContent(fingerprint: string, page: number): string | undefined;
  findLatestCompleted(): RetainedDocument | undefined;
  claimImport(fingerprint: string): boolean;
  markRetained(fingerprint: string): void;
  markCompleted(fingerprint: string): void;
}

export function createDocumentRepository(database: SqliteDatabase): DocumentRepository {
  const find = database.prepare("SELECT * FROM documents WHERE fingerprint = ?");
  const insert = database.prepare(`
    INSERT INTO documents (id, fingerprint, filename, source_path, import_status, created_at)
    VALUES (?, ?, ?, ?, 'retained', ?)
  `);
  const claim = database.prepare(
    "UPDATE documents SET import_status = 'importing' WHERE fingerprint = ? AND import_status = 'retained'"
  );
  const reset = database.prepare(
    "UPDATE documents SET import_status = 'retained' WHERE fingerprint = ? AND import_status = 'importing'"
  );
  const complete = database.prepare(
    "UPDATE documents SET import_status = 'completed' WHERE fingerprint = ? AND import_status = 'importing'"
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

  const findByFingerprint = (fingerprint: string): RetainedDocument | undefined => {
    const row = find.get(fingerprint) as DocumentRow | undefined;
    return row ? parseDocument(row) : undefined;
  };

  return {
    createRetained(document) {
      insert.run(document.id, document.fingerprint, document.filename, document.sourcePath, document.createdAt);
      return findByFingerprint(document.fingerprint)!;
    },
    findByFingerprint,
    findPageContent(fingerprint, page) {
      return (findPage.get(fingerprint, page) as { content: string } | undefined)?.content;
    },
    findLatestCompleted() {
      const row = findLatestCompleted.get() as DocumentRow | undefined;
      return row ? parseDocument(row) : undefined;
    },
    claimImport(fingerprint) {
      return claim.run(fingerprint).changes === 1;
    },
    markRetained(fingerprint) {
      reset.run(fingerprint);
    },
    markCompleted(fingerprint) {
      if (complete.run(fingerprint).changes !== 1) throw new Error("document import is not claimed");
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
    createdAt: row.created_at
  };
}
