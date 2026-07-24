import { createCanvas } from "@napi-rs/canvas";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

const OCR_RENDER_SCALE = 2;

export class OcrOutputError extends Error {}

export async function renderPageForOcr(page: PDFPageProxy): Promise<Uint8Array> {
  const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");

  // PDF.js models the browser's canvas context more narrowly than the native canvas package.
  await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
  return Uint8Array.from(canvas.encodeSync("png"));
}
