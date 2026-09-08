import { createHash } from "node:crypto";
import { z } from "zod";
import type { EvidenceRef } from "@resume/contracts";
import { EvidenceRefSchema, JsonValueSchema } from "@resume/contracts";
import {
  asRecord,
  parseSpecialistAgentResult,
  type SpecialistAgent,
  type SpecialistAgentInput,
  type SpecialistAgentResult,
  validateSpecialistInput
} from "./specialist-agent.js";

const ReviewInputSchema = z.object({
  payload: JsonValueSchema.optional(),
  evidenceRefs: z.array(EvidenceRefSchema).max(500).default([]),
  targetFingerprint: z.string().min(1).max(256).optional(),
  expectedTargetFingerprint: z.string().min(1).max(256).optional(),
  sensitiveFields: z.array(z.string().min(1).max(128)).max(50).default([]),
  unsupportedClaims: z.array(z.string().min(1).max(500)).max(50).default([]),
  factsConsistent: z.boolean().default(true)
}).strict();

export interface ReviewAgentOptions {
  readonly sensitiveKeyPattern?: RegExp;
  readonly evidenceValidator?: (ref: EvidenceRef, input: SpecialistAgentInput) => boolean;
  readonly version?: string;
}

export function createReviewAgent(options: ReviewAgentOptions = {}): SpecialistAgent {
  const sensitiveKeyPattern = options.sensitiveKeyPattern ?? /(?:password|passwd|token|secret|cookie|authorization|credential)/iu;
  return {
    name: "review_agent",
    version: options.version ?? "1.0.0",
    async execute(input): Promise<SpecialistAgentResult> {
      try {
        validateSpecialistInput(input);
        const review = ReviewInputSchema.parse(asRecord(input.input));
        const evidence = review.evidenceRefs.filter((ref) => options.evidenceValidator?.(ref, input) ?? true);
        const reasons: string[] = [];
        if (evidence.length === 0) reasons.push("evidence_incomplete");
        if (!review.factsConsistent) reasons.push("facts_inconsistent");
        if (review.targetFingerprint !== undefined
          && review.expectedTargetFingerprint !== undefined
          && review.targetFingerprint !== review.expectedTargetFingerprint) {
          reasons.push("target_identity_mismatch");
        }
        if (review.sensitiveFields.some((field) => sensitiveKeyPattern.test(field))) reasons.push("sensitive_field_requires_review");
        if (review.unsupportedClaims.length > 0) reasons.push("unsupported_claim");
        if (containsSensitiveKey(review.payload, sensitiveKeyPattern)) reasons.push("sensitive_payload_field");
        const payloadHash = createHash("sha256").update(JSON.stringify(review.payload ?? null)).digest("hex");
        if (reasons.length > 0) {
          return parseSpecialistAgentResult({
            status: "blocked",
            blockReason: reasons[0],
            evidenceRefs: evidence,
            payloadHash,
            submitted: false
          });
        }
        return parseSpecialistAgentResult({
          status: "completed",
          outputRef: `review:${input.runId}:${input.step.id}`,
          evidenceRefs: evidence,
          payloadHash,
          submitted: false
        });
      } catch (error) {
        return parseSpecialistAgentResult({
          status: "failed",
          errorCode: error instanceof Error && /^[a-z0-9_:-]+$/u.test(error.message) ? error.message : "review_agent_failed",
          evidenceRefs: []
        });
      }
    }
  };
}

function containsSensitiveKey(value: unknown, pattern: RegExp): boolean {
  if (Array.isArray(value)) return value.some((item) => containsSensitiveKey(item, pattern));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, nested]) => pattern.test(key) || containsSensitiveKey(nested, pattern));
}
