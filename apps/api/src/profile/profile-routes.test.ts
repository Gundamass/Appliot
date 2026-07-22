import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractedDocument } from "@resume/profile-domain/src/pdf/types.js";
import { migrateDatabase } from "../db/migrate.js";
import { createApp, type AppDependencies } from "../app.js";
import { InvalidPdfError, ProfileImportUnavailableError } from "./import-service.js";
import { createProfileRepository } from "./profile-repository.js";

const MAX_PDF_BYTES = 15 * 1024 * 1024;

interface MultipartFilePart {
  type: "file";
  name?: string;
  filename?: string;
  mimeType?: string;
  bytes: Uint8Array;
}

interface MultipartFieldPart {
  type: "field";
  name: string;
  value: string;
}

function multipart(
  parts: Array<MultipartFilePart | MultipartFieldPart>,
  complete = true
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "resume-test-boundary";
  const buffers: Buffer[] = [];

  for (const part of parts) {
    if (part.type === "file") {
      buffers.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name ?? "file"}"; filename="${part.filename ?? "resume.pdf"}"\r\nContent-Type: ${part.mimeType ?? "application/pdf"}\r\n\r\n`
      ));
      buffers.push(Buffer.from(part.bytes));
      buffers.push(Buffer.from("\r\n"));
    } else {
      buffers.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`
      ));
    }
  }
  if (complete) buffers.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(buffers),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  };
}

function multipartPdf(bytes: Uint8Array, mimeType = "application/pdf") {
  return multipart([{ type: "file", bytes, mimeType }]);
}

function pdfBytes(size = 12): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 5));
  bytes.set(Buffer.from("%PDF-"));
  return bytes;
}

const testResources: Array<{ app: Awaited<ReturnType<typeof createApp>>; database: InstanceType<typeof Database> }> = [];

afterEach(async () => {
  for (const { app, database } of testResources.splice(0).reverse()) {
    await app.close().catch(() => undefined);
    if (database.open) database.close();
  }
});

async function buildTestContext(overrides: Partial<AppDependencies> = {}) {
  const database = new Database(":memory:");
  migrateDatabase(database);
  const document: ExtractedDocument = {
    fingerprint: "a".repeat(64),
    pages: [{ page: 1, text: "Ada Lovelace ada@example.com", source: "pdf_text" }]
  };
  const dependencies: AppDependencies = {
    database,
    profileRepository: createProfileRepository(database),
    extractPdf: async () => document,
    extractFacts: async () => [{
      id: "fact-1",
      fieldPath: "basics.email",
      value: "ada@example.com",
      status: "extracted",
      confidence: 0.99,
      scope: "profile",
      evidence: [{ documentId: document.fingerprint, page: 1, text: "ada@example.com", extraction: "pdf_text" }],
      revision: 1
    }],
    ...overrides
  };
  const app = await createApp(dependencies);
  const context = { app, database };
  testResources.push(context);
  return context;
}

async function buildTestApp(overrides: Partial<AppDependencies> = {}) {
  return (await buildTestContext(overrides)).app;
}

function tableCount(database: InstanceType<typeof Database>, table: "documents" | "document_chunks" | "profile_facts"): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe("profile routes", () => {
  it("imports facts as extracted and requires explicit confirmation", async () => {
    const app = await buildTestApp();
    const upload = await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes()) });

    expect(upload.statusCode).toBe(202);
    expect(upload.json()).toEqual({ documentId: expect.any(String), fingerprint: "a".repeat(64) });

    const facts = await app.inject({ method: "GET", url: "/api/profile/facts" });
    expect(facts.statusCode).toBe(200);
    expect(facts.json()).toEqual([expect.objectContaining({
      id: "fact-1",
      status: "extracted",
      evidence: [expect.any(Object)]
    })]);
  });

  it("rejects a duplicate document without duplicating its extracted facts", async () => {
    const app = await buildTestApp();
    const request = { method: "POST" as const, url: "/api/documents", ...multipartPdf(pdfBytes()) };

    expect((await app.inject(request)).statusCode).toBe(202);
    expect((await app.inject(request)).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/profile/facts" })).json()).toHaveLength(1);
  });

  it("confirms and corrects facts with revision evidence", async () => {
    const app = await buildTestApp();
    await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes()) });

    const confirmed = await app.inject({ method: "POST", url: "/api/profile/facts/fact-1/confirm" });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: "user_confirmed", revision: 1 });

    const corrected = await app.inject({
      method: "POST",
      url: "/api/profile/facts/fact-1/correct",
      payload: { value: "ada@analytical.engine" }
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({
      status: "user_corrected",
      value: "ada@analytical.engine",
      confidence: 1,
      revision: 2,
      evidence: [{
        documentId: "user",
        page: 1,
        text: "Corrected value: \"ada@analytical.engine\"",
        extraction: "user"
      }]
    });
  });

  it("returns 400 for invalid correction payloads", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/profile/facts/fact-1/correct",
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid request" });
  });

  it("rejects forged correction evidence and extra keys", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/profile/facts/fact-1/correct",
      payload: {
        value: "forged@example.com",
        evidence: [{ documentId: "resume", page: 1, text: "forged", extraction: "pdf_text" }]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid request" });
  });

  it("accepts an absent or strict empty confirmation body", async () => {
    const app = await buildTestApp();
    await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes()) });

    expect((await app.inject({ method: "POST", url: "/api/profile/facts/fact-1/confirm" })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: "/api/profile/facts/fact-1/confirm",
      payload: {}
    })).statusCode).toBe(200);
  });

  it("rejects unexpected confirmation body keys", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/profile/facts/fact-1/confirm",
      payload: { confirm: true }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid request" });
  });

  it("rejects a non-PDF declared MIME type", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes(), "text/plain") });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid PDF upload" });
  });

  it("rejects a PDF MIME type with an invalid PDF signature", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(Buffer.from("not a PDF")) });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid PDF upload" });
  });

  it("accepts a PDF at the 15 MiB boundary", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes(MAX_PDF_BYTES)) });

    expect(response.statusCode).toBe(202);
  });

  it("rejects a PDF larger than 15 MiB", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes(MAX_PDF_BYTES + 1)) });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid request" });
  });

  it("returns 404 for missing facts", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "POST", url: "/api/profile/facts/missing/confirm" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Profile fact not found" });
  });

  it("returns 404 when correcting a missing fact", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/profile/facts/missing/correct",
      payload: { value: "Ada" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Profile fact not found" });
  });

  it("returns 400 for an explicitly classified malformed signed PDF", async () => {
    const app = await buildTestApp({
      extractPdf: async () => { throw new InvalidPdfError(); }
    });
    const response = await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes()) });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid PDF upload" });
  });

  it("returns 503 for explicitly classified extraction unavailability", async () => {
    const app = await buildTestApp({
      extractFacts: async () => { throw new ProfileImportUnavailableError(); }
    });
    const response = await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes()) });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Profile import is temporarily unavailable" });
  });

  it("returns 500 for unexpected extractor failures", async () => {
    const app = await buildTestApp({
      extractPdf: async () => { throw new Error("unexpected extractor defect"); }
    });
    const response = await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes()) });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
  });

  it("returns 500 for unexpected repository failures", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createProfileRepository(database);
    const createExtracted = vi.spyOn(repository, "createExtracted").mockImplementation(() => {
      throw new Error("unexpected repository defect");
    });
    const app = await buildTestApp({ profileRepository: repository });
    const response = await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes()) });

    expect(createExtracted).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
    database.close();
  });

  for (const malformed of [
    {
      name: "fingerprint",
      document: { fingerprint: "invalid", pages: [{ page: 1, text: "Ada", source: "pdf_text" }] }
    },
    {
      name: "page",
      document: { fingerprint: "b".repeat(64), pages: [{ page: 0, text: "Ada", source: "pdf_text" }] }
    }
  ] as const) {
    it(`validates a malformed extracted ${malformed.name} before persistence and permits retry`, async () => {
      let valid = false;
      const extractFacts = vi.fn(async () => []);
      const validDocument: ExtractedDocument = {
        fingerprint: "b".repeat(64),
        pages: [{ page: 1, text: "Ada", source: "pdf_text" }]
      };
      const { app, database } = await buildTestContext({
        extractPdf: async () => valid ? validDocument : malformed.document as unknown as ExtractedDocument,
        extractFacts
      });
      const transaction = vi.spyOn(database, "transaction");

      const rejected = await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes()) });
      expect(rejected.statusCode).toBe(500);
      expect(rejected.json()).toEqual({ error: "Internal server error" });
      expect(transaction).not.toHaveBeenCalled();
      expect(tableCount(database, "documents")).toBe(0);
      expect(extractFacts).not.toHaveBeenCalled();

      valid = true;
      expect((await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes()) })).statusCode).toBe(202);
      expect(extractFacts).toHaveBeenCalledOnce();
    });
  }

  it("validates malformed extracted facts before persistence and permits retry", async () => {
    let valid = false;
    const { app, database } = await buildTestContext({
      extractFacts: async () => valid ? [] : [{
        id: "malformed-fact",
        fieldPath: "basics.email",
        value: "ada@example.com",
        status: "user_confirmed",
        confidence: 1,
        scope: "profile",
        evidence: [{ documentId: "a".repeat(64), page: 1, text: "ada@example.com", extraction: "pdf_text" }],
        revision: 1
      }]
    });
    const transaction = vi.spyOn(database, "transaction");

    const rejected = await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes()) });
    expect(rejected.statusCode).toBe(500);
    expect(transaction).not.toHaveBeenCalled();
    expect(tableCount(database, "documents")).toBe(0);

    valid = true;
    expect((await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes()) })).statusCode).toBe(202);
  });

  for (const multipartCase of [
    {
      name: "a file under the wrong field name",
      request: multipart([{ type: "file", name: "resume", bytes: pdfBytes() }])
    },
    {
      name: "a field before the file",
      request: multipart([
        { type: "field", name: "note", value: "unexpected" },
        { type: "file", bytes: pdfBytes() }
      ])
    },
    {
      name: "a trailing field",
      request: multipart([
        { type: "file", bytes: pdfBytes() },
        { type: "field", name: "note", value: "unexpected" }
      ])
    },
    {
      name: "a trailing file",
      request: multipart([
        { type: "file", bytes: pdfBytes() },
        { type: "file", bytes: pdfBytes(), filename: "second.pdf" }
      ])
    },
    {
      name: "an incomplete multipart body",
      request: multipart([{ type: "file", bytes: pdfBytes() }], false)
    }
  ]) {
    it(`consumes and rejects multipart input containing ${multipartCase.name} before persistence`, async () => {
      const { app, database } = await buildTestContext();
      const response = await app.inject({ method: "POST", url: "/api/documents", ...multipartCase.request });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Invalid request" });
      expect(tableCount(database, "documents")).toBe(0);
    });
  }

  it("rejects an oversized multipart file before persistence", async () => {
    const { app, database } = await buildTestContext();
    const response = await app.inject({
      method: "POST",
      url: "/api/documents",
      ...multipartPdf(pdfBytes(MAX_PDF_BYTES + 1))
    });

    expect(response.statusCode).toBe(400);
    expect(tableCount(database, "documents")).toBe(0);
  });

  it("atomically rejects concurrent duplicate imports", async () => {
    const app = await buildTestApp();
    const request = { method: "POST" as const, url: "/api/documents", ...multipartPdf(pdfBytes()) };
    const responses = await Promise.all([app.inject(request), app.inject(request)]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
  });

  it("closes only explicitly owned resources", async () => {
    const owned = vi.fn();
    const callerContext = await buildTestContext();
    const ownedApp = await buildTestApp({ close: owned } as Partial<AppDependencies>);

    await callerContext.app.close();
    await ownedApp.close();

    expect(callerContext.database.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
    expect(owned).toHaveBeenCalledOnce();
  });
});
