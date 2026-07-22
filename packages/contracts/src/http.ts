import { z } from "zod";

export const DocumentResponseSchema = z.object({
  documentId: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const ErrorResponseSchema = z.object({
  error: z.string().min(1)
}).strict();

export type DocumentResponse = z.infer<typeof DocumentResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
