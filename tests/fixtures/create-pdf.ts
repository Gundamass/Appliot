import { PDFDocument, StandardFonts } from "pdf-lib";

const scannedResumeImage = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARzQklUCAgICHwIZIgAAABNSURBVDiN1ZCxEcAgDAOfHBN4t0yZ3bSCaTkuNIgC1Nt6fcnMxEgFiIilY0k8TjvgPyiuA5tgSaKkfQSXOei3byM4xME3cfD+bB5jT2iwjyAQf6ZWiAAAAABJRU5ErkJggg==";

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

export async function createScannedPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([306, 396]);
  const image = await document.embedPng(scannedResumeImage);

  page.drawImage(image, { x: 0, y: 0, width: 306, height: 396 });
  return document.save();
}
