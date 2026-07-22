import { describe, expect, it } from "vitest";
import { createPdf } from "../../../../tests/fixtures/create-pdf.js";
import { extractPdf } from "./extract-pdf.js";

describe("extractPdf", () => {
  it("preserves page numbers and uses OCR only for empty pages", async () => {
    const pdf = await createPdf(["Ada Lovelace\nada@example.com", "", "Short text"]);
    const images: Uint8Array[] = [];
    const ocr = {
      async recognize(image: Uint8Array, language: "chi_sim+eng"): Promise<string> {
        images.push(image);
        expect(language).toBe("chi_sim+eng");
        return "Scanned work experience";
      }
    };

    const result = await extractPdf(pdf, ocr);

    expect(result.pages).toEqual([
      expect.objectContaining({ page: 1, source: "pdf_text", text: expect.stringContaining("Ada Lovelace") }),
      { page: 2, source: "ocr", text: "Scanned work experience" },
      expect.objectContaining({ page: 3, source: "pdf_text", text: "Short text" })
    ]);
    expect(images).toHaveLength(1);
    expect([...images[0]!.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("returns a stable SHA-256 fingerprint for duplicate PDF bytes", async () => {
    const pdf = await createPdf(["Same resume"]);
    const ocr = { recognize: async (): Promise<string> => "unused" };

    const first = await extractPdf(pdf, ocr);
    const second = await extractPdf(Uint8Array.from(pdf), ocr);

    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});
