import {
  RagFieldAnswerBodySchema,
  RagFieldCorrectionResponseSchema,
  RagFieldInspectionSchema,
  RagFieldRequestSchema,
  type RagFieldRequest
} from "@resume/contracts";
import { createRagService, planField, type FieldRequest, type KeywordSearchInput } from "@resume/rag";
import type { FastifyInstance } from "fastify";
import { sendError } from "../http-response.js";
import type { ProfileRepository } from "../profile/profile-repository.js";

export function registerRagRoutes(
  app: FastifyInstance,
  dependencies: { profileRepository: ProfileRepository }
): void {
  const service = createRagService({
    repository: dependencies.profileRepository,
    search: {
      async search(input: KeywordSearchInput) {
        const terms = `${input.query} ${input.jobDescription ?? ""}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        return dependencies.profileRepository.listForTask(input.taskId)
          .filter((fact) => {
            const searchable = `${fact.fieldPath} ${JSON.stringify(fact.value)} ${fact.evidence.map((item) => item.text).join(" ")}`.toLowerCase();
            return terms.some((term) => searchable.includes(term));
          })
          .slice(0, input.limit);
      }
    }
  });

  app.post("/api/rag/fields/resolve", async (request, reply) => {
    const parsed = RagFieldRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid request");
    const field = toFieldRequest(parsed.data);
    const plan = planField(field);
    const decision = await service.resolveField(field);
    return reply.code(200).send(RagFieldInspectionSchema.parse({ request: field, plan, decision }));
  });

  app.post("/api/rag/fields/answer", async (request, reply) => {
    const parsed = RagFieldAnswerBodySchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid request");
    const { value, promoteToProfile, profileFactId } = parsed.data;
    const field = toFieldRequest(parsed.data);
    try {
      const correction = service.applyAnswer({
        ...field,
        value,
        evidence: [{
          documentId: "user",
          page: 1,
          text: display(value),
          extraction: "user"
        }],
        ...(promoteToProfile === true ? { promoteToProfile: true } : {}),
        ...(profileFactId === undefined ? {} : { profileFactId })
      });
      const plan = planField(field);
      const decision = await service.resolveField(field);
      return reply.code(200).send(RagFieldCorrectionResponseSchema.parse({
        correction,
        inspection: { request: field, plan, decision }
      }));
    } catch {
      return sendError(reply, 409, "Field answer cannot be applied");
    }
  });
}

function toFieldRequest(input: RagFieldRequest): FieldRequest {
  return {
    taskId: input.taskId,
    fieldId: input.fieldId,
    semantic: input.semantic,
    label: input.label,
    type: input.type,
    ...(input.options === undefined ? {} : { options: input.options }),
    ...(input.validators === undefined ? {} : { validators: input.validators }),
    ...(input.jobDescription === undefined ? {} : { jobDescription: input.jobDescription })
  };
}

function display(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
