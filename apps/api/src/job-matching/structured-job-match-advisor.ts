import { JobRequirementSchema } from "@resume/contracts";
import type { StructuredModelProvider } from "@resume/model-provider";
import { z } from "zod";
import type { JobMatchAdvisor } from "../agent/subgraphs/job-matching.js";

const EvidenceCandidateSchema = z.object({
  evidenceId: z.string().min(1).max(200),
  normalizedCategory: z.string().min(1).max(200),
  normalizedValue: z.string().min(1).max(500)
}).strict();

const AdvisoryRequestSchema = z.object({
  requirement: JobRequirementSchema.pick({
    id: true,
    category: true,
    normalizedValue: true,
    required: true
  }),
  evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(3),
  evidence: z.array(EvidenceCandidateSchema).min(1).max(3)
}).strict().superRefine((input, context) => {
  const evidenceIds = new Set(input.evidenceIds);
  const candidateIds = new Set(input.evidence.map((item) => item.evidenceId));
  if (evidenceIds.size !== input.evidenceIds.length
    || candidateIds.size !== input.evidence.length
    || evidenceIds.size !== candidateIds.size
    || [...evidenceIds].some((id) => !candidateIds.has(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "job_match_advisor_evidence_mismatch" });
  }
});

const ModelAdvisorySchema = z.object({
  outcome: z.enum(["satisfied", "unknown"]),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string().min(1).max(200)).max(3)
}).strict();

/**
 * Narrows the model boundary to one requirement and the already validated
 * evidence candidates. The graph remains responsible for final validation.
 */
export function createStructuredJobMatchAdvisor(provider: StructuredModelProvider): JobMatchAdvisor {
  return Object.freeze({
    async advise(input: Parameters<JobMatchAdvisor["advise"]>[0]) {
      const request = AdvisoryRequestSchema.parse(input);
      const result = await provider.generateStructured({
        system: "你是招聘要求的受限证据仲裁器。只能依据给定的 requirement 和 evidence 判断是否支持该要求。无法确定时返回 outcome=unknown。不得编造事实、证据 ID 或其他字段，只返回 JSON。",
        user: JSON.stringify({ requirement: request.requirement, evidence: request.evidence }),
        schema: ModelAdvisorySchema,
        jsonExample: {
          outcome: "satisfied",
          confidence: 0.95,
          evidenceIds: [request.evidenceIds[0]!]
        }
      });
      return ModelAdvisorySchema.parse(result);
    }
  });
}
