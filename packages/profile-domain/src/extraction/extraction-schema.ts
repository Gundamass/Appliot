import { JsonValueSchema } from "@resume/contracts";
import { isAllowedExtractedFieldPath } from "@resume/form-semantics";
import { z } from "zod";

const ExtractionCandidateSchema = z.object({
  fieldPath: z.string().min(1).refine(isAllowedExtractedFieldPath, "field path is not allowed for profile extraction"),
  value: JsonValueSchema,
  page: z.number().int().positive(),
  quote: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

export const ExtractionSchema = z.object({
  facts: z.array(ExtractionCandidateSchema)
});

export type ExtractionOutput = z.infer<typeof ExtractionSchema>;
