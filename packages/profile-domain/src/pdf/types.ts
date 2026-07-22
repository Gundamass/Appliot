export interface ExtractedPage {
  page: number;
  text: string;
  source: "pdf_text" | "ocr";
}

export interface ExtractedDocument {
  fingerprint: string;
  pages: ExtractedPage[];
}

export interface OcrEngine {
  recognize(image: Uint8Array, language: "chi_sim+eng"): Promise<string>;
}
