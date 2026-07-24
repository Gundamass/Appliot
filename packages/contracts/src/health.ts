import { z } from "zod";

export const AdapterIdSchema = z.enum(["deepseek", "embedding", "ocr"]);
export const AdapterStateSchema = z.enum([
  "unconfigured",
  "configured",
  "checking",
  "ready",
  "unavailable",
  "invalid"
]);
export const AdapterHealthCodeSchema = z.enum([
  "not_configured",
  "not_checked",
  "offline",
  "not_ready",
  "contract_mismatch"
]);

export const AdapterStatusSchema = z.object({
  id: AdapterIdSchema,
  state: AdapterStateSchema,
  model: z.string().optional(),
  modelRevision: z.string().optional(),
  code: AdapterHealthCodeSchema.optional()
}).strict();

export const AdapterHealthResponseSchema = z.array(AdapterStatusSchema).length(3).superRefine((statuses, context) => {
  const ids = new Set(statuses.map((status) => status.id));
  for (const id of AdapterIdSchema.options) {
    if (!ids.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Missing adapter: ${id}` });
  }
});

export type AdapterId = z.infer<typeof AdapterIdSchema>;
export type AdapterState = z.infer<typeof AdapterStateSchema>;
export type AdapterHealthCode = z.infer<typeof AdapterHealthCodeSchema>;
export type AdapterStatus = z.infer<typeof AdapterStatusSchema>;
export type AdapterHealthResponse = z.infer<typeof AdapterHealthResponseSchema>;
