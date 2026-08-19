import { HintPackDefinitionSchema } from "@resume/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { sendError } from "../http-response.js";
import type { AdapterReviewService } from "./adapter-review-service.js";

const ProposalParamsSchema = z.object({ proposalId: z.string().min(1).max(128) }).strict();
const PackParamsSchema = z.object({ packId: z.string().min(1).max(64), version: z.string().min(1).max(32) }).strict();
const DecisionBodySchema = z.object({
  decision: z.enum(["certify", "reject", "revise"]),
  aiReviewUnavailable: z.boolean(),
  acknowledgedAiUnavailable: z.boolean(),
  notes: z.string().max(4000).optional()
}).strict();
const RetireBodySchema = z.object({ reason: z.string().min(1).max(1000) }).strict();

export function registerAdapterRoutes(app: FastifyInstance, service: AdapterReviewService): void {
  app.get("/api/ats-adapters/proposals/:proposalId", async (request, reply) => {
    const params = ProposalParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, "invalid_adapter_proposal_id");
    const review = service.get(params.data.proposalId);
    return review === undefined
      ? sendError(reply, 404, "ATS adapter proposal not found", "adapter_proposal_not_found")
      : reply.code(200).send(review);
  });

  app.post("/api/ats-adapters/proposals/:proposalId/replay", async (request, reply) => {
    const params = ProposalParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, "invalid_adapter_proposal_id");
    return execute(reply, 200, () => service.replay(params.data.proposalId));
  });

  app.post("/api/ats-adapters/proposals/:proposalId/ai-review", async (request, reply) => {
    const params = ProposalParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, "invalid_adapter_proposal_id");
    return execute(reply, 200, async () => {
      const review = await service.requestAiReview(params.data.proposalId);
      if (review.aiReview === undefined && review.aiReviewUnavailable) throw new Error("adapter_ai_unavailable");
      return review;
    });
  });

  app.post("/api/ats-adapters/proposals/:proposalId/revise", async (request, reply) => {
    const params = ProposalParamsSchema.safeParse(request.params);
    const definition = HintPackDefinitionSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_adapter_proposal_id");
    if (!definition.success) return invalid(reply, "invalid_adapter_revision_input");
    return execute(reply, 201, () => service.revise(params.data.proposalId, definition.data));
  });

  app.post("/api/ats-adapters/proposals/:proposalId/decision", async (request, reply) => {
    const params = ProposalParamsSchema.safeParse(request.params);
    const input = DecisionBodySchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_adapter_proposal_id");
    if (!input.success) return invalid(reply, "invalid_adapter_decision_input");
    return execute(reply, 200, () => service.decide(params.data.proposalId, input.data));
  });

  app.post("/api/ats-adapters/packs/:packId/:version/retire", async (request, reply) => {
    const params = PackParamsSchema.safeParse(request.params);
    const input = RetireBodySchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_adapter_pack_id");
    if (!input.success) return invalid(reply, "invalid_adapter_retirement_input");
    return execute(reply, 204, () => service.retire(params.data.packId, params.data.version, input.data.reason));
  });
}

async function execute(reply: FastifyReply, successStatus: number, operation: () => unknown | Promise<unknown>) {
  try {
    return reply.code(successStatus).send(await operation());
  } catch (error) {
    const mapped = mapAdapterError(error);
    return sendError(reply, mapped.statusCode, mapped.error, mapped.code);
  }
}

function invalid(reply: FastifyReply, code: string) {
  return sendError(reply, 400, "Invalid request", code);
}

function mapAdapterError(error: unknown): { statusCode: number; error: string; code: string } {
  const code = error instanceof Error ? error.message : "adapter_operation_failed";
  if (code === "adapter_proposal_not_found") {
    return { statusCode: 404, error: "ATS adapter proposal not found", code };
  }
  if (code === "adapter_ai_unavailable") {
    return { statusCode: 503, error: "AI replay review is temporarily unavailable", code };
  }
  if (CONFLICT_CODES.has(code)) {
    return { statusCode: 409, error: "ATS adapter operation conflicts with current lifecycle", code };
  }
  if (REQUEST_CODES.has(code)) {
    return { statusCode: 400, error: "Invalid request", code };
  }
  return { statusCode: 500, error: "Internal server error", code: "adapter_operation_failed" };
}

const CONFLICT_CODES = new Set([
  "adapter_transition_denied",
  "adapter_replay_required",
  "hard_gate_failed",
  "adapter_replay_fixture_invalid",
  "adapter_ai_review_report_missing",
  "synthetic_replay_submission_detected"
]);

const REQUEST_CODES = new Set([
  "adapter_sensitive_payload_rejected",
  "adapter_version_invalid"
]);
