import { z } from "zod";

export const DocumentResponseSchema = z.object({
  documentId: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const ProfileDocumentSummarySchema = z.object({
  documentId: z.string().uuid(),
  filename: z.string().min(1),
  importedAt: z.string().datetime({ offset: true }),
  extractedFactCount: z.number().int().nonnegative()
}).strict();

export const LatestProfileDocumentResponseSchema = z.object({
  document: ProfileDocumentSummarySchema.nullable()
}).strict();

export const DocumentImportStatusSchema = z.enum(["retained", "importing", "completed", "failed"]);

export const CurrentProfileDocumentSummarySchema = ProfileDocumentSummarySchema.extend({
  importStatus: DocumentImportStatusSchema
}).strict();

export const CurrentProfileDocumentResponseSchema = z.object({
  document: CurrentProfileDocumentSummarySchema.nullable()
}).strict();

export const ErrorResponseSchema = z.object({
  error: z.string().min(1),
  code: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
  taskId: z.string().uuid().optional()
}).strict();

export type DocumentResponse = z.infer<typeof DocumentResponseSchema>;
export type ProfileDocumentSummary = z.infer<typeof ProfileDocumentSummarySchema>;
export type LatestProfileDocumentResponse = z.infer<typeof LatestProfileDocumentResponseSchema>;
export type DocumentImportStatus = z.infer<typeof DocumentImportStatusSchema>;
export type CurrentProfileDocumentSummary = z.infer<typeof CurrentProfileDocumentSummarySchema>;
export type CurrentProfileDocumentResponse = z.infer<typeof CurrentProfileDocumentResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
