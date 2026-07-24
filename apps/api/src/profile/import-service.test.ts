import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createProfileRepository } from "./profile-repository.js";
import { createLocalOriginalDocumentStore } from "./original-document-store.js";
import { DuplicateDocumentError, importProfileDocument, ProfileImportUnavailableError } from "./import-service.js";
import { createProductionExtraction } from "./production-extraction.js";
import { createScannedPdf } from "../../../../tests/fixtures/create-pdf.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("importProfileDocument", () => {
  it("retains the exact original before extraction and reuses it after a failed retry", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const root = await mkdtemp(join(tmpdir(), "resume-import-"));
    roots.push(root);
    const bytes = Buffer.from("%PDF-retain even when extraction fails");
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    let fail = true;
    const extractPdf = vi.fn(async () => {
      if (fail) throw new Error("extractor failed");
      return { fingerprint, pages: [{ page: 1, text: "Ada", source: "pdf_text" as const }] };
    });
    const dependencies = {
      database,
      profileRepository: createProfileRepository(database),
      originalDocumentStore: createLocalOriginalDocumentStore(root),
      extractPdf,
      extractFacts: vi.fn(async () => [])
    };

    await expect(importProfileDocument(dependencies, "resume.pdf", bytes)).rejects.toThrow("extractor failed");
    const retained = database.prepare("SELECT * FROM documents WHERE fingerprint = ?").get(fingerprint) as {
      id: string;
      source_path: string;
      import_status: string;
    };
    expect(retained.import_status).toBe("retained");
    expect(await readFile(retained.source_path)).toEqual(bytes);

    fail = false;
    const imported = await importProfileDocument(dependencies, "renamed.pdf", Uint8Array.from(bytes));
    expect(imported.documentId).toBe(retained.id);
    expect((database.prepare("SELECT import_status FROM documents WHERE id = ?").get(retained.id) as { import_status: string }).import_status).toBe("completed");
    expect(await readFile(retained.source_path)).toEqual(bytes);
    database.close();
  });

  it("rejects a completed duplicate before PDF, OCR, or model extraction", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const root = await mkdtemp(join(tmpdir(), "resume-duplicate-"));
    roots.push(root);
    const bytes = Buffer.from("%PDF-completed duplicate");
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    const extractPdf = vi.fn(async () => ({ fingerprint, pages: [{ page: 1, text: "Ada", source: "pdf_text" as const }] }));
    const extractFacts = vi.fn(async () => []);
    const dependencies = {
      database,
      profileRepository: createProfileRepository(database),
      originalDocumentStore: createLocalOriginalDocumentStore(root),
      extractPdf,
      extractFacts
    };

    await importProfileDocument(dependencies, "resume.pdf", bytes);
    extractPdf.mockClear();
    extractFacts.mockClear();

    await expect(importProfileDocument(dependencies, "resume.pdf", Uint8Array.from(bytes))).rejects.toBeInstanceOf(DuplicateDocumentError);
    expect(extractPdf).not.toHaveBeenCalled();
    expect(extractFacts).not.toHaveBeenCalled();
    database.close();
  });

  it("retains a scanned PDF when production OCR is unavailable", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const root = await mkdtemp(join(tmpdir(), "resume-ocr-unavailable-"));
    roots.push(root);
    const bytes = await createScannedPdf();
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    const dependencies = {
      database,
      profileRepository: createProfileRepository(database),
      originalDocumentStore: createLocalOriginalDocumentStore(root),
      ...createProductionExtraction({})
    };

    await expect(importProfileDocument(dependencies, "resume.pdf", bytes)).rejects.toBeInstanceOf(ProfileImportUnavailableError);
    expect((database.prepare("SELECT import_status FROM documents WHERE fingerprint = ?").get(fingerprint) as { import_status: string }).import_status).toBe("retained");
    database.close();
  });
});
