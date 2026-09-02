import { z } from "zod";
import { JsonValueSchema } from "./profile.js";

export const CapabilityKindSchema = z.enum(["read", "transform", "act", "observe"]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;

export const CapabilityRiskSchema = z.enum(["low", "medium", "high", "irreversible"]);
export type CapabilityRisk = z.infer<typeof CapabilityRiskSchema>;

export const CapabilitySideEffectSchema = z.enum(["none", "reversible", "external", "irreversible"]);
export type CapabilitySideEffect = z.infer<typeof CapabilitySideEffectSchema>;

export const CapabilityCallerSchema = z.enum(["supervisor", "specialist_agent", "graph", "runtime"]);
export type CapabilityCaller = z.infer<typeof CapabilityCallerSchema>;

export const CapabilityIdempotencySchema = z.enum(["idempotent", "keyed", "none"]);
export type CapabilityIdempotency = z.infer<typeof CapabilityIdempotencySchema>;

const CapabilityNameSchema = z.string().regex(/^[a-z][a-z0-9_.:-]{1,120}$/u);

export const CapabilityDescriptorSchema = z.object({
  name: CapabilityNameSchema,
  version: z.string().min(1).max(32),
  kind: CapabilityKindSchema,
  risk: CapabilityRiskSchema,
  sideEffect: CapabilitySideEffectSchema,
  allowedCallers: z.array(CapabilityCallerSchema).min(1).max(4),
  requiresApproval: z.boolean(),
  idempotency: CapabilityIdempotencySchema,
  timeoutMs: z.number().int().positive().max(300_000),
  inputSchema: JsonValueSchema.optional(),
  outputSchema: JsonValueSchema.optional(),
  handlerRef: z.string().min(1).max(256).optional()
}).strict().superRefine((descriptor, context) => {
  if (descriptor.risk === "irreversible" && !descriptor.requiresApproval) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "irreversible_capability_requires_approval" });
  }
  if (descriptor.risk === "irreversible" && !descriptor.allowedCallers.includes("graph")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "irreversible_capability_requires_graph_caller" });
  }
  if (descriptor.name === "final_submit") {
    if (descriptor.risk !== "irreversible") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "final_submit_must_be_irreversible" });
    }
    if (descriptor.sideEffect !== "external" && descriptor.sideEffect !== "irreversible") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "final_submit_must_have_external_side_effect" });
    }
    if (!descriptor.requiresApproval) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "final_submit_requires_approval" });
    }
    if (!descriptor.allowedCallers.includes("graph")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "final_submit_requires_graph_caller" });
    }
  }
});

export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

export const CapabilityInvocationSchema = z.object({
  invocationId: z.string().min(1).max(128),
  capability: CapabilityNameSchema,
  version: z.string().min(1).max(32),
  caller: CapabilityCallerSchema,
  runId: z.string().min(1).max(128),
  input: JsonValueSchema,
  idempotencyKey: z.string().min(1).max(256).optional()
}).strict();

export type CapabilityInvocation = z.infer<typeof CapabilityInvocationSchema>;

export const CapabilityExecutionResultSchema = z.object({
  invocationId: z.string().min(1).max(128),
  status: z.enum(["completed", "blocked", "failed"]),
  outputRef: z.string().min(1).max(256).optional(),
  evidenceRefs: z.array(z.string().min(1).max(128)).max(100),
  errorCode: z.string().regex(/^[a-z0-9_:-]{1,120}$/u).optional()
}).strict();

export type CapabilityExecutionResult = z.infer<typeof CapabilityExecutionResultSchema>;
