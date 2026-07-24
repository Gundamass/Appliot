import { describe, expect, it, vi } from "vitest";
import type { StructuredModelProvider } from "@resume/model-provider";
import { InvalidPdfDocumentError } from "@resume/profile-domain/src/pdf/extract-pdf.js";
import { RemoteOcrError } from "@resume/profile-domain/src/pdf/remote-ocr-engine.js";
import { createPdf, createScannedPdf } from "../../../../tests/fixtures/create-pdf.js";
import { ProfileImportUnavailableError } from "./import-service.js";
import { createProductionExtraction } from "./production-extraction.js";

function structuredProvider(): StructuredModelProvider {
  return {
    async generateStructured<T>(): Promise<T> {
      return { facts: [] } as T;
    }
  };
}

describe("createProductionExtraction", () => {
  it("imports a native-text PDF while OCR is unavailable", async () => {
    const extraction = createProductionExtraction({ structuredProvider: structuredProvider() });

    await expect(extraction.extractPdf(await createPdf(["Ada Lovelace\nada@example.com"]))).resolves.toMatchObject({
      pages: [expect.objectContaining({ source: "pdf_text" })]
    });
  });

  it("maps a scanned-page OCR outage to ProfileImportUnavailableError", async () => {
    const extraction = createProductionExtraction({ structuredProvider: structuredProvider() });

    await expect(extraction.extractPdf(await createScannedPdf())).rejects.toBeInstanceOf(ProfileImportUnavailableError);
  });

  it.each([
    ["network", new RemoteOcrError("network", true)],
    ["timeout", new RemoteOcrError("timeout", true)],
    ["retry-exhausted 5xx", new RemoteOcrError("response", true)]
  ])("maps %s OCR unavailability to ProfileImportUnavailableError", async (_caseName, ocrError) => {
    const extraction = createProductionExtraction({
      structuredProvider: structuredProvider(),
      ocrEngine: { async recognize() { throw ocrError; } }
    });

    await expect(extraction.extractPdf(await createScannedPdf())).rejects.toBeInstanceOf(ProfileImportUnavailableError);
  });

  it.each([
    ["authentication", new RemoteOcrError("authentication", false)],
    ["configuration", new RemoteOcrError("configuration", false)],
    ["input", new RemoteOcrError("input", false)],
    ["contract response", new RemoteOcrError("response", false)]
  ])("preserves %s OCR failures", async (_caseName, ocrError) => {
    const extraction = createProductionExtraction({
      structuredProvider: structuredProvider(),
      ocrEngine: { async recognize() { throw ocrError; } }
    });

    await expect(extraction.extractPdf(await createScannedPdf())).rejects.toBe(ocrError);
  });

  it("preserves malformed PDF errors", async () => {
    const extraction = createProductionExtraction({ structuredProvider: structuredProvider() });

    await expect(extraction.extractPdf(Buffer.from("%PDF-malformed"))).rejects.toBeInstanceOf(InvalidPdfDocumentError);
  });

  it("preserves unexpected OCR defects", async () => {
    const defect = new Error("OCR implementation defect");
    const extraction = createProductionExtraction({
      structuredProvider: structuredProvider(),
      ocrEngine: { recognize: vi.fn(async () => { throw defect; }) }
    });

    await expect(extraction.extractPdf(await createScannedPdf())).rejects.toBe(defect);
  });

  it("maps an absent structured provider to ProfileImportUnavailableError", async () => {
    const extraction = createProductionExtraction({});

    await expect(extraction.extractFacts({
      fingerprint: "a".repeat(64),
      pages: [{ page: 1, text: "Ada Lovelace", source: "pdf_text" }]
    })).rejects.toBeInstanceOf(ProfileImportUnavailableError);
  });
});
