import { PDFDocument, StandardFonts } from "pdf-lib";

export async function createPdf(pageTexts: readonly string[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);

  for (const pageText of pageTexts) {
    const page = document.addPage([612, 792]);
    pageText.split(/\r?\n/).forEach((line, index) => {
      if (line.length > 0) page.drawText(line, { font, size: 12, x: 72, y: 720 - (index * 18) });
    });
  }

  return document.save();
}
