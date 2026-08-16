import { z } from "zod";

export const ChallengeKindSchema = z.enum([
  "captcha",
  "access_denied",
  "rate_limited",
  "device_verification",
  "risk_control",
  "unsupported_iframe",
  "unsupported_shadow_dom"
]);

export const DomBoundarySchema = z.object({
  kind: z.enum(["iframe", "shadow_root", "closed_shadow_host"]),
  visible: z.boolean(),
  interactive: z.boolean(),
  reasonCode: z.string().min(1).max(128)
}).strict();

export const ChallengeDiagnosticSchema = z.object({
  kind: ChallengeKindSchema,
  detectedAt: z.string().datetime(),
  reasonCode: z.string().min(1).max(128)
}).strict();

export type ChallengeKind = z.infer<typeof ChallengeKindSchema>;
export type DomBoundary = z.infer<typeof DomBoundarySchema>;
export type ChallengeDiagnostic = z.infer<typeof ChallengeDiagnosticSchema>;
