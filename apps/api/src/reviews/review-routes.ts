import { SelfEvaluationDraftSchema } from "@resume/contracts";
import { validateEditedSelfEvaluation } from "@resume/rag";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "../http-response.js";
import type { ProfileRepository } from "../profile/profile-repository.js";
import type { SelfEvaluationReviewRepository } from "./review-repository.js";

const ParamsSchema = z.object({ taskId: z.string().min(1).max(128) }).strict();
const CreateBodySchema = z.object({ draft: SelfEvaluationDraftSchema }).strict();
const ApproveBodySchema = z.object({ editedDraft: z.string().min(1).max(12_000).optional() }).strict();
const PromoteBodySchema = z.object({ profileFactId: z.string().min(1).max(128) }).strict();
const SelfEvaluationFieldPath = "selfEvaluation";

export interface ReviewRouteDependencies { reviewRepository: SelfEvaluationReviewRepository; profileRepository: ProfileRepository; }

export function registerReviewRoutes(app: FastifyInstance, dependencies: ReviewRouteDependencies): void {
  app.get("/api/reviews/self-evaluations/:taskId", async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "Invalid request");
    const review = dependencies.reviewRepository.get(params.data.taskId);
    return review ? reply.code(200).send(SelfEvaluationDraftSchema.parse(review)) : sendError(reply, 404, "Review not found");
  });
  app.post("/api/reviews/self-evaluations/:taskId", async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params); const body = CreateBodySchema.safeParse(request.body);
    if (!params.success || !body.success || body.data.draft.taskId !== params.data.taskId || body.data.draft.status !== "needs_review" || body.data.draft.unsupportedClaims.length > 0) return sendError(reply, 400, "Invalid request");
    const eligibleEvidence = dependencies.profileRepository.listActive()
      .filter((fact) => (fact.status === "user_confirmed" || fact.status === "user_corrected") && (fact.scope === "profile" || fact.taskId === params.data.taskId))
      .flatMap((fact) => fact.evidence);
    if (body.data.draft.evidence.some((item) => !eligibleEvidence.some((candidate) => JSON.stringify(candidate) === JSON.stringify(item))) || validateEditedSelfEvaluation(body.data.draft.original, body.data.draft.draft, body.data.draft.evidence).length > 0) return sendError(reply, 400, "Invalid request");
    if (dependencies.reviewRepository.get(params.data.taskId)?.status === "approved" || dependencies.reviewRepository.isPromoted(params.data.taskId)) return sendError(reply, 409, "Review cannot be created");
    try { return reply.code(201).send(SelfEvaluationDraftSchema.parse(dependencies.reviewRepository.save(body.data.draft))); }
    catch { return sendError(reply, 409, "Review cannot be created"); }
  });
  app.post("/api/reviews/self-evaluations/:taskId/approve", async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params); const body = ApproveBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "Invalid request");
    const submitted = dependencies.reviewRepository.get(params.data.taskId);
    if (!submitted || submitted.status !== "needs_review" || submitted.unsupportedClaims.length > 0) return sendError(reply, 409, "Review cannot be approved");
    const edited = body.data.editedDraft;
    if (edited && validateEditedSelfEvaluation(submitted.original, edited, submitted.evidence).length > 0) return sendError(reply, 409, "Edited draft contains unsupported claims");
    if (dependencies.reviewRepository.isPromoted(params.data.taskId)) return sendError(reply, 409, "Review already approved");
    try {
      if (edited) dependencies.reviewRepository.save(SelfEvaluationDraftSchema.parse({ ...submitted, draft: edited }));
      const approved = dependencies.reviewRepository.approve(params.data.taskId);
      dependencies.profileRepository.putTaskAnswer(params.data.taskId, SelfEvaluationFieldPath, approved.draft, [{ documentId: "user", page: 1, text: "Approved self-evaluation review", extraction: "user" }]);
      return reply.code(200).send(SelfEvaluationDraftSchema.parse(approved));
    } catch { return sendError(reply, 409, "Review cannot be approved"); }
  });
  app.post("/api/reviews/self-evaluations/:taskId/promote", async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params); const body = PromoteBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "Invalid request");
    const review = dependencies.reviewRepository.get(params.data.taskId);
    if (!review || review.status !== "approved" || dependencies.reviewRepository.isPromoted(params.data.taskId)) return sendError(reply, 409, "Review is not eligible for promotion");
    const target = dependencies.profileRepository.listActive().find((fact) => fact.id === body.data.profileFactId);
    if (!target || target.scope !== "profile" || target.fieldPath !== SelfEvaluationFieldPath || target.status === "superseded") return sendError(reply, 400, "Invalid profile target");
    try {
      dependencies.profileRepository.correct(target.id, review.draft, [{ documentId: "user", page: 1, text: `Promoted approved self-evaluation from task ${params.data.taskId}`, extraction: "user" }]);
      dependencies.reviewRepository.markPromoted(params.data.taskId);
      return reply.code(200).send(SelfEvaluationDraftSchema.parse(review));
    } catch { return sendError(reply, 409, "Review cannot be promoted"); }
  });
}
