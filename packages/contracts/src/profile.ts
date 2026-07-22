import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema = z.unknown().superRefine((value, context) => {
  const ancestors = new Set<object>();

  const validate = (candidate: unknown, path: (string | number)[]): void => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (Number.isFinite(candidate)) return;
      context.addIssue({ code: z.ZodIssueCode.custom, message: "JSON numbers must be finite", path });
      return;
    }
    if (typeof candidate !== "object") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "value must be JSON", path });
      return;
    }
    if (ancestors.has(candidate)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "JSON values cannot be cyclic", path });
      return;
    }
    ancestors.add(candidate);
    if (typeof (candidate as { toJSON?: unknown }).toJSON === "function") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "JSON values cannot define toJSON", path });
      ancestors.delete(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      for (let index = 0; index < candidate.length; index += 1) {
        if (!(index in candidate)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "JSON arrays cannot be sparse", path: [...path, index] });
        } else {
          validate(candidate[index], [...path, index]);
        }
      }
    } else if (Object.getPrototypeOf(candidate) === Object.prototype || Object.getPrototypeOf(candidate) === null) {
      Object.entries(candidate).forEach(([key, item]) => validate(item, [...path, key]));
    } else {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "value must be a JSON object", path });
    }
    ancestors.delete(candidate);
  };

  validate(value, []);
}) as z.ZodType<JsonValue>;

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
  value: JsonValueSchema,
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
  if (fact.scope === "profile" && fact.taskId) {
    context.addIssue({ code: "custom", message: "profile facts cannot have taskId" });
  }
});

export type ProfileFact = z.infer<typeof ProfileFactSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type FactStatus = z.infer<typeof FactStatusSchema>;
export type FactScope = z.infer<typeof FactScopeSchema>;
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;
