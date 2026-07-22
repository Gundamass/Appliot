import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderPageForOcr } from "./ocr.js";
import type { ExtractedDocument, ExtractedPage, OcrEngine } from "./types.js";

const require = createRequire(import.meta.url);
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

export class InvalidPdfDocumentError extends Error {}

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

        if (hasUsablePdfText(text)) {
          pages.push({ page: pageNumber, text, source: "pdf_text" });
        } else {
          const image = await renderPageForOcr(page);
          const ocrText = await ocr.recognize(image, "chi_sim+eng");
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
