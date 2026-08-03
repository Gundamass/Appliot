import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { OcrOutputError, renderPageForOcr } from "./ocr.js";
import type { ExtractedDocument, ExtractedPage, OcrEngine } from "./types.js";

const require = createRequire(import.meta.url);
const MIN_VISIBLE_CHARACTERS = 8;
const CORRUPT_CHARACTER_RATIO = 0.1;
const REPLACEMENT_CHARACTER = "\uFFFD";
const VISIBLE_CHARACTER = /[\p{L}\p{N}]/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const WHITESPACE_CHARACTER = /\s/u;
const standardFontDataUrl = `${resolve(
  dirname(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")),
  "../../standard_fonts"
).replaceAll("\\", "/")}/`;

function textFromPage(items: readonly unknown[]): string {
  let text = "";

  for (const item of items) {
    if (typeof item !== "object" || item === null || !("str" in item) || typeof item.str !== "string") continue;
    if (item.str.length > 0) {
      if (text.length > 0 && !/[\s\n]$/.test(text)) text += " ";
      text += item.str;
    }
    if ("hasEOL" in item && item.hasEOL === true) text = `${text.trimEnd()}\n`;
  }

  return text.trim();
}

export function hasUsablePdfText(text: string): boolean {
  return text.replace(/[\s\p{Cc}\p{Cf}\p{M}\p{Z}]/gu, "").length > 0;
}

export function classifyPdfText(text: string): "usable" | "empty" | "corrupt" | "suspiciously_short" {
  let visibleCount = 0;
  let replacementCount = 0;
  let controlCount = 0;
  let nonWhitespaceCount = 0;

  for (const character of text.normalize("NFKC")) {
    if (!WHITESPACE_CHARACTER.test(character)) nonWhitespaceCount += 1;
    if (VISIBLE_CHARACTER.test(character)) visibleCount += 1;
    if (character === REPLACEMENT_CHARACTER) replacementCount += 1;
    if (CONTROL_CHARACTER.test(character)) controlCount += 1;
  }

  if (visibleCount === 0) return "empty";
  if (replacementCount / nonWhitespaceCount >= CORRUPT_CHARACTER_RATIO) return "corrupt";
  if (controlCount / nonWhitespaceCount >= CORRUPT_CHARACTER_RATIO) return "corrupt";
  if (visibleCount < MIN_VISIBLE_CHARACTERS) return "suspiciously_short";
  return "usable";
}

export class InvalidPdfDocumentError extends Error {}

export async function renderPdfPage(bytes: Uint8Array, pageNumber: number): Promise<Uint8Array> {
  if (!Number.isInteger(pageNumber) || pageNumber <= 0) throw new RangeError("PDF page number is invalid");
  const loadingTask = getDocument({
    data: Uint8Array.from(bytes),
    standardFontDataUrl
  });
  try {
    const document = await loadingTask.promise;
    if (pageNumber > document.numPages) throw new RangeError("PDF page does not exist");
    const page = await document.getPage(pageNumber);
    try {
      return await renderPageForOcr(page);
    } finally {
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}

export async function extractPdf(bytes: Uint8Array, ocr: OcrEngine): Promise<ExtractedDocument> {
  const snapshot = Uint8Array.from(bytes);
  const fingerprint = createHash("sha256").update(snapshot).digest("hex");
  const loadingTask = getDocument({
    data: snapshot,
    standardFontDataUrl
  });

  try {
    let document: Awaited<typeof loadingTask.promise>;
    try {
      document = await loadingTask.promise;
    } catch (error) {
      throw new InvalidPdfDocumentError("PDF parser rejected the document", { cause: error });
    }
    const pages: ExtractedPage[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);

      try {
        const content = await page.getTextContent();
        const text = textFromPage(content.items);

        if (classifyPdfText(text) === "usable") {
          pages.push({ page: pageNumber, text, source: "pdf_text" });
        } else {
          const image = await renderPageForOcr(page);
          const ocrText = await ocr.recognize(image);
          if (!hasUsablePdfText(ocrText)) throw new OcrOutputError("OCR returned blank text");
          pages.push({ page: pageNumber, text: ocrText, source: "ocr" });
        }
      } finally {
        page.cleanup();
      }
    }

    return {
      fingerprint,
      pages
    };
  } finally {
    await loadingTask.destroy();
  }
}
