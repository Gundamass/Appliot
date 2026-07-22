import {
  ApproveSelfEvaluationReviewBodySchema,
  CreateSelfEvaluationReviewBodySchema,
  PromoteSelfEvaluationReviewBodySchema,
  SelfEvaluationReviewSchema,
  type ProfileFact,
  type SelfEvaluationReview
} from "@resume/contracts";
import type { ModelProvider } from "@resume/model-provider";
import { tailorSelfEvaluation, validateEditedSelfEvaluation } from "@resume/rag";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "../http-response.js";
import type { ProfileRepository } from "../profile/profile-repository.js";
import type { SelfEvaluationReviewRepository } from "./review-repository.js";

const ParamsSchema = z.object({ taskId: z.string().min(1).max(128) }).strict();
const SelfEvaluationFieldPath = "selfEvaluation";
export interface ReviewRouteDependencies {
  reviewRepository: SelfEvaluationReviewRepository;
  profileRepository: ProfileRepository;
  selfEvaluationModelProvider?: ModelProvider;
}

export function registerReviewRoutes(app: FastifyInstance, dependencies: ReviewRouteDependencies): void {
  app.get("/api/reviews/self-evaluations/:taskId", async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "Invalid request");
    const review = dependencies.reviewRepository.get(params.data.taskId);
    return review ? reply.code(200).send(SelfEvaluationReviewSchema.parse(review)) : sendError(reply, 404, "Review not found");
  });

  app.post("/api/reviews/self-evaluations/:taskId", async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params); const body = CreateSelfEvaluationReviewBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "Invalid request");
    const base = selectBase(dependencies.profileRepository.listActive());
    if (!base) return sendError(reply, 409, "No reviewed self-evaluation is available");
    if (!dependencies.selfEvaluationModelProvider) return sendError(reply, 503, "Self-evaluation tailoring is temporarily unavailable");
    const facts = eligibleFacts(dependencies.profileRepository.listForTask(params.data.taskId), params.data.taskId);
    const draft = await tailorSelfEvaluation({
      taskId: params.data.taskId,
      original: base.value as string,
      jobDescription: body.data.jobDescription,
      facts
    }, dependencies.selfEvaluationModelProvider);
    if (draft.status !== "needs_review") return sendError(reply, 400, "Draft contains unsupported claims");
    const review = SelfEvaluationReviewSchema.parse({
      ...draft,
      jobDescription: body.data.jobDescription,
      base: { factId: base.id, revision: base.revision, original: base.value, evidence: base.evidence }
    });
    try { return reply.code(201).send(SelfEvaluationReviewSchema.parse(dependencies.reviewRepository.save(review))); }
    catch { return sendError(reply, 409, "Review cannot be created"); }
  });

  app.post("/api/reviews/self-evaluations/:taskId/approve", async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params); const body = ApproveSelfEvaluationReviewBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "Invalid request");
    try {
      const approved = dependencies.profileRepository.transaction(() => {
        const review = requireReview(dependencies.reviewRepository, params.data.taskId, "needs_review");
        if (!baseStillCurrent(review, dependencies.profileRepository)) throw new Error("base changed");
        const value = body.data.keepOriginal === true ? review.base.original : (body.data.editedDraft ?? review.draft);
        const evidence = review.evidence;
        if (validateEditedSelfEvaluation(review.base.original, value, evidence).length > 0) throw new Error("unsupported edit");
        if (value !== review.draft) dependencies.reviewRepository.save(SelfEvaluationReviewSchema.parse({ ...review, draft: value }));
        const transitioned = dependencies.reviewRepository.approve(params.data.taskId);
        dependencies.profileRepository.putTaskAnswer(params.data.taskId, SelfEvaluationFieldPath, value, [{ documentId: "user", page: 1, text: body.data.keepOriginal ? "Kept original self-evaluation" : "Approved self-evaluation review", extraction: "user" }]);
        return transitioned;
      });
      return reply.code(200).send(SelfEvaluationReviewSchema.parse(approved));
    } catch { return sendError(reply, 409, "Review cannot be approved"); }
  });

  app.post("/api/reviews/self-evaluations/:taskId/promote", async (request, reply) => {
    const params = ParamsSchema.safeParse(request.params); const body = PromoteSelfEvaluationReviewBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "Invalid request");
    try {
      const promoted = dependencies.profileRepository.transaction(() => {
        const review = requireReview(dependencies.reviewRepository, params.data.taskId, "approved");
        if (!baseStillCurrent(review, dependencies.profileRepository)) throw new Error("base changed");
        dependencies.profileRepository.correct(review.base.factId, review.draft, [{ documentId: "user", page: 1, text: `Promoted approved self-evaluation from task ${params.data.taskId}`, extraction: "user" }]);
        return dependencies.reviewRepository.markPromoted(params.data.taskId);
      });
      return reply.code(200).send(SelfEvaluationReviewSchema.parse(promoted));
    } catch { return sendError(reply, 409, "Review cannot be promoted"); }
  });
}

function selectBase(facts: ProfileFact[]): ProfileFact | undefined {
  return facts.find((fact) => fact.scope === "profile" && fact.fieldPath === SelfEvaluationFieldPath && typeof fact.value === "string" && (fact.status === "user_confirmed" || fact.status === "user_corrected"));
}
function eligibleFacts(facts: ProfileFact[], taskId: string): ProfileFact[] {
  return facts.filter((fact) => (fact.status === "user_confirmed" || fact.status === "user_corrected") && (fact.scope === "profile" || (fact.scope === "application" && fact.taskId === taskId)));
}
function requireReview(repository: SelfEvaluationReviewRepository, taskId: string, status: "needs_review" | "approved"): SelfEvaluationReview {
  const review = repository.get(taskId); if (!review || review.status !== status) throw new Error("review transition conflict"); return review;
}
function baseStillCurrent(review: SelfEvaluationReview, repository: ProfileRepository): boolean {
  const fact = repository.getById(review.base.factId);
  return !!fact && fact.scope === "profile" && fact.fieldPath === SelfEvaluationFieldPath && fact.revision === review.base.revision && fact.value === review.base.original && (fact.status === "user_confirmed" || fact.status === "user_corrected");
}
