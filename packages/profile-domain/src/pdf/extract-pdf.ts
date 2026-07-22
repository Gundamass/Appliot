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
  return items
    .map((item) => {
      if (typeof item !== "object" || item === null || !("str" in item)) return "";
      return typeof item.str === "string" ? item.str : "";
    })
    .filter((text) => text.length > 0)
    .join(" ")
    .trim();
}

export async function extractPdf(bytes: Uint8Array, ocr: OcrEngine): Promise<ExtractedDocument> {
  const loadingTask = getDocument({
    data: Uint8Array.from(bytes),
    standardFontDataUrl
  });

  try {
    const document = await loadingTask.promise;
    const pages: ExtractedPage[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = textFromPage(content.items);

      if (text.length > 0) {
        pages.push({ page: pageNumber, text, source: "pdf_text" });
      } else {
        const image = await renderPageForOcr(page);
        const ocrText = await ocr.recognize(image, "chi_sim+eng");
        pages.push({ page: pageNumber, text: ocrText, source: "ocr" });
      }
    }

    return {
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
      pages
    };
  } finally {
    await loadingTask.destroy();
  }
}
