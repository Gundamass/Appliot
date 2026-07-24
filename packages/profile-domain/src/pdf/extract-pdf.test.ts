import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import {
  PDFDocument,
  PDFHexString,
  StandardFonts,
  beginText,
  endText,
  moveText,
  setFontAndSize,
  showText
} from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it, vi } from "vitest";
import { createPdf, createScannedPdf } from "../../../../tests/fixtures/create-pdf.js";
import { OcrOutputError } from "./ocr.js";
import { classifyPdfText, extractPdf, hasUsablePdfText, InvalidPdfDocumentError } from "./extract-pdf.js";

describe("extractPdf", () => {
  it("preserves page numbers and uses OCR only for image-only pages", async () => {
    const textPdf = await createPdf(["Ada Lovelace\nada@example.com", "Short text"]);
    const scannedPdf = await createScannedPdf();
    const pdf = await appendPdfPages(textPdf, scannedPdf);
    const images: Uint8Array[] = [];
    const ocr = {
      async recognize(image: Uint8Array): Promise<string> {
        images.push(image);
        return "Scanned work experience";
      }
    };

    const result = await extractPdf(pdf, ocr);

    expect(result.pages).toEqual([
      expect.objectContaining({ page: 1, source: "pdf_text", text: expect.stringContaining("Ada Lovelace") }),
      expect.objectContaining({ page: 2, source: "pdf_text", text: "Short text" }),
      { page: 3, source: "ocr", text: "Scanned work experience" }
    ]);
    expect(images).toHaveLength(1);
    const rendered = await loadImage(images[0]!);
    expect(rendered.width).toBe(612);
    expect(rendered.height).toBe(792);
    const canvas = createCanvas(rendered.width, rendered.height);
    const context = canvas.getContext("2d");
    context.drawImage(rendered, 0, 0);
    const pixels = context.getImageData(0, 0, rendered.width, rendered.height).data;
    expect(countPixels(pixels, (red, green, blue, alpha) => (
      alpha === 255 && red < 40 && green < 40 && blue < 40
    ))).toBeGreaterThan(1_000);
    expect(countPixels(pixels, (red, green, blue, alpha) => (
      alpha === 255 && red > 100 && green < 80 && blue < 80
    ))).toBeGreaterThan(100);
  });

  it("uses OCR only for corrupt and image-only pages", async () => {
    const textPdf = await createPdf(["Ada Lovelace\nada@example.com"]);
    const corruptTextPdf = await createControlHeavyPdf();
    const scannedPdf = await createScannedPdf();
    const pdf = await appendPdfPages(textPdf, corruptTextPdf, scannedPdf);
    const recognize = vi.fn(async (): Promise<string> => "OCR fallback text");

    const result = await extractPdf(pdf, { recognize });

    expect(result.pages).toEqual([
      expect.objectContaining({ page: 1, source: "pdf_text", text: expect.stringContaining("Ada Lovelace") }),
      { page: 2, source: "ocr", text: "OCR fallback text" },
      { page: 3, source: "ocr", text: "OCR fallback text" }
    ]);
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it("returns a stable SHA-256 fingerprint for duplicate PDF bytes", async () => {
    const pdf = await createPdf(["Same resume"]);
    const ocr = { recognize: async (): Promise<string> => "unused" };

    const first = await extractPdf(pdf, ocr);
    const second = await extractPdf(Uint8Array.from(pdf), ocr);

    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("uses one immutable byte snapshot for PDF parsing and fingerprinting", async () => {
    const pdf = await createScannedPdf();
    const snapshot = Uint8Array.from(pdf);
    const ocr = {
      async recognize(): Promise<string> {
        pdf.fill(0);
        return "Scanned resume";
      }
    };

    const result = await extractPdf(pdf, ocr);

    expect(result.fingerprint).toBe(createHash("sha256").update(snapshot).digest("hex"));
    expect(result.pages).toEqual([{ page: 1, source: "ocr", text: "Scanned resume" }]);
  });

  it("falls back to OCR when extracted PDF text has no visible evidence", () => {
    expect(hasUsablePdfText("\u0000\u200B\u200C\u200D\u2060\uFE0F\uFEFF")).toBe(false);
    expect(hasUsablePdfText("A\u0301")).toBe(true);
  });

  it.each([
    ["Ada Lovelace\nada@example.com", "usable"],
    ["\u0000\u200B\u200C\u200D\u2060\uFEFF", "empty"],
    ["A\uFFFD\uFFFD\uFFFD\uFFFD", "corrupt"],
    ["A", "suspiciously_short"]
  ])("classifies PDF text %j as %s", (text, expected) => {
    expect(classifyPdfText(text)).toBe(expected);
  });

  it("preserves PDF text line boundaries", async () => {
    const result = await extractPdf(await createPdf(["First line\nSecond line"]), unusedOcr);

    expect(result.pages).toEqual([
      expect.objectContaining({ source: "pdf_text", text: "First line\nSecond line" })
    ]);
  });

  it("releases each page when OCR fails", async () => {
    const pdf = await createScannedPdf();
    const loadingTask = getDocument({ data: Uint8Array.from(pdf) });
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    const cleanup = vi.spyOn(Object.getPrototypeOf(page), "cleanup");

    try {
      await expect(extractPdf(pdf, {
        async recognize(): Promise<string> { throw new Error("OCR unavailable"); }
      })).rejects.toThrow("OCR unavailable");

      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      cleanup.mockRestore();
      await loadingTask.destroy();
    }
  });

  it("rejects blank OCR output without appending an empty page", async () => {
    const pdf = await createScannedPdf();

    await expect(extractPdf(pdf, {
      async recognize(): Promise<string> { return " \n\t "; }
    })).rejects.toBeInstanceOf(OcrOutputError);
  });

  it("propagates malformed PDF errors", async () => {
    await expect(extractPdf(Buffer.from("%PDF-malformed"), unusedOcr)).rejects.toBeInstanceOf(InvalidPdfDocumentError);
  });
});

const unusedOcr = { async recognize(): Promise<string> { throw new Error("OCR should not run"); } };

async function appendPdfPages(...documents: Uint8Array[]): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const result = await PDFDocument.create();
  for (const bytes of documents) {
    const source = await PDFDocument.load(bytes);
    const pages = await result.copyPages(source, source.getPageIndices());
    pages.forEach((page) => result.addPage(page));
  }
  return result.save();
}

async function createControlHeavyPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.pushOperators(
    beginText(),
    setFontAndSize(font.name, 12),
    moveText(72, 720),
    showText(PDFHexString.of("4100410041004100410041004100410041004100")),
    endText()
  );
  return document.save();
}

function countPixels(
  pixels: Uint8ClampedArray,
  matches: (red: number, green: number, blue: number, alpha: number) => boolean
): number {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (matches(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!, pixels[index + 3]!)) count += 1;
  }
  return count;
}
