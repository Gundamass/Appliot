import type { StructuredModelProvider } from "@resume/model-provider";
import { extractFacts as extractProfileFacts } from "@resume/profile-domain/src/extraction/extract-facts.js";
import { extractPdf as extractProfilePdf } from "@resume/profile-domain/src/pdf/extract-pdf.js";
import { RemoteOcrError } from "@resume/profile-domain/src/pdf/remote-ocr-engine.js";
import type { ExtractedDocument, OcrEngine } from "@resume/profile-domain/src/pdf/types.js";
import { ProfileImportUnavailableError } from "./import-service.js";

export interface ProductionExtractionDependencies {
  structuredProvider?: StructuredModelProvider;
  ocrEngine?: OcrEngine;
}

class UnavailableOcrError extends Error {}

class UnavailableOcrEngine implements OcrEngine {
  async recognize(_image: Uint8Array): Promise<string> {
    throw new UnavailableOcrError();
  }
}

export function createProductionExtraction(dependencies: ProductionExtractionDependencies) {
  const ocrEngine = dependencies.ocrEngine ?? new UnavailableOcrEngine();

  return {
    async extractPdf(bytes: Uint8Array): Promise<ExtractedDocument> {
      try {
        return await extractProfilePdf(bytes, ocrEngine);
      } catch (error) {
        if (error instanceof UnavailableOcrError || (error instanceof RemoteOcrError && error.unavailable)) {
          throw new ProfileImportUnavailableError();
        }
        throw error;
      }
    },

    async extractFacts(document: ExtractedDocument) {
      if (!dependencies.structuredProvider) throw new ProfileImportUnavailableError();
      return extractProfileFacts(document, dependencies.structuredProvider);
    }
  };
}
