import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ExtractedDocument } from "@resume/profile-domain/src/pdf/types.js";
import { migrateDatabase } from "../db/migrate.js";
import { createApp, type AppDependencies } from "../app.js";
import { createProfileRepository } from "./profile-repository.js";

const MAX_PDF_BYTES = 15 * 1024 * 1024;

function multipartPdf(bytes: Uint8Array, mimeType = "application/pdf"): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "resume-test-boundary";
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="resume.pdf"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([prefix, Buffer.from(bytes), suffix]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  };
}

function pdfBytes(size = 12): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 5));
  bytes.set(Buffer.from("%PDF-"));
  return bytes;
}

function buildTestApp(overrides: Partial<AppDependencies> = {}) {
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
  return createApp(dependencies);
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
      payload: {
        value: "ada@analytical.engine",
        evidence: [{ documentId: "user", page: 1, text: "Ada provided this address", extraction: "user" }]
      }
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({
      status: "user_corrected",
      value: "ada@analytical.engine",
      confidence: 1,
      revision: 2
    });
  });

  it("returns 400 for invalid correction payloads", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/profile/facts/fact-1/correct",
      payload: { value: "missing evidence", evidence: [] }
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
      payload: { value: "Ada", evidence: [{ documentId: "user", page: 1, text: "Ada", extraction: "user" }] }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Profile fact not found" });
  });

  it("rejects PDF content the extractor cannot parse without leaking internals", async () => {
    const app = await buildTestApp({
      extractPdf: async () => { throw new Error("OCR service credential rejected"); }
    });
    const response = await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes()) });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid PDF upload" });
  });

  it("maps fact extraction dependency failures without leaking internals", async () => {
    const app = await buildTestApp({
      extractFacts: async () => { throw new Error("provider credential rejected"); }
    });
    const response = await app.inject({ method: "POST", url: "/api/documents", ...multipartPdf(pdfBytes()) });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Profile import is temporarily unavailable" });
  });
});
