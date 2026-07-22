import { z } from "zod";

export const FactStatusSchema = z.enum([
  "extracted",
  "user_confirmed",
  "user_corrected",
  "superseded"
]);
export const FactScopeSchema = z.enum(["profile", "application"]);
export const DecisionStatusSchema = z.enum([
  "verified_auto",
  "needs_review",
  "needs_question",
  "blocked"
]);
export const EvidenceSchema = z.object({
  documentId: z.string().min(1),
  page: z.number().int().positive(),
  text: z.string().min(1),
  extraction: z.enum(["pdf_text", "ocr", "user"])
});
export const ProfileFactSchema = z.object({
  id: z.string().min(1),
  fieldPath: z.string().min(1),
  value: z.unknown(),
  status: FactStatusSchema,
  confidence: z.number().min(0).max(1),
  scope: FactScopeSchema,
  taskId: z.string().min(1).optional(),
  evidence: z.array(EvidenceSchema).min(1),
  revision: z.number().int().positive()
}).superRefine((fact, context) => {
  if (fact.scope === "application" && !fact.taskId) {
    context.addIssue({ code: "custom", message: "application facts require taskId" });
  }
});

export type ProfileFact = z.infer<typeof ProfileFactSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type FactStatus = z.infer<typeof FactStatusSchema>;
export type FactScope = z.infer<typeof FactScopeSchema>;
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;
