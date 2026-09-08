import {
  ConversationJobMatchActionResultSchema,
  ConversationJobMatchActionSchema
} from "@resume/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { sendError } from "../http-response.js";
import type { ConversationJobMatchService } from "./conversation-job-match-service.js";

const ConversationParamsSchema = z.object({ conversationId: z.string().trim().min(1).max(256) }).strict();
const SessionParamsSchema = z.object({ sessionId: z.string().trim().min(1).max(256) }).strict();
const OwningConversationSchema = z.object({ conversationId: z.string().trim().min(1).max(256) }).strict();

export interface ConversationJobMatchRouteDependencies {
  service: ConversationJobMatchService;
}

export function registerConversationJobMatchRoutes(
  app: FastifyInstance,
  dependencies: ConversationJobMatchRouteDependencies
): void {
  app.post("/api/conversations/:conversationId/job-match-actions", async (request, reply) => {
    const params = ConversationParamsSchema.safeParse(request.params);
    const input = ConversationJobMatchActionSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_conversation_id");
    if (!input.success) return invalid(reply, "invalid_conversation_job_match_action");
    if (input.data.conversationId !== params.data.conversationId) {
      return invalid(reply, "conversation_job_match_conversation_mismatch");
    }
    return execute(reply, 200, async () => ConversationJobMatchActionResultSchema.parse(
      await dependencies.service.execute(params.data.conversationId, input.data)
    ));
  });

  app.get("/api/job-match-sessions/:sessionId/conversation", async (request, reply) => {
    const params = SessionParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, "invalid_job_match_session_id");
    return execute(reply, 200, async () => {
      const owner = await dependencies.service.findOwningConversation(params.data.sessionId);
      if (owner === undefined) throw new Error("conversation_not_found");
      return OwningConversationSchema.parse(owner);
    });
  });
}

async function execute(
  reply: FastifyReply,
  successStatus: number,
  operation: () => unknown | Promise<unknown>
) {
  try {
    return reply.code(successStatus).send(await operation());
  } catch (error) {
    const mapped = mapConversationJobMatchError(error);
    return sendError(reply, mapped.statusCode, mapped.error, mapped.code);
  }
}

function invalid(reply: FastifyReply, code: string) {
  return sendError(reply, 400, "Invalid request", code);
}

function mapConversationJobMatchError(error: unknown): {
  statusCode: number;
  error: string;
  code: string;
} {
  const code = errorCode(error);
  if (code === "conversation_not_found" || code === "job_match_session_not_found") {
    return {
      statusCode: 404,
      error: code === "conversation_not_found" ? "Conversation not found" : "Job match session not found",
      code
    };
  }
  if (code === "conversation_job_match_not_owned") {
    return { statusCode: 403, error: "Job match session does not belong to this conversation", code };
  }
  if (code === "job_expectation_required") {
    return { statusCode: 422, error: "Job expectation is required", code };
  }
  if (code.startsWith("conversation_job_match_") && code.endsWith("_invalid")) {
    return { statusCode: 400, error: "Invalid request", code };
  }
  if (CONFLICT_CODES.has(code)) {
    return { statusCode: 409, error: "Job match operation conflicts with current state", code };
  }
  return { statusCode: 500, error: "Internal server error", code: "conversation_job_match_operation_failed" };
}

function errorCode(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_:-]+$/u.test(error.message)
    ? error.message
    : "conversation_job_match_operation_failed";
}

const CONFLICT_CODES = new Set([
  "conversation_idempotency_conflict",
  "conversation_context_conflict",
  "conversation_context_version_invalid",
  "conversation_sequence_conflict",
  "conversation_message_mismatch",
  "conversation_job_match_link_conflict",
  "job_match_version_conflict",
  "job_match_mutation_not_allowed",
  "job_match_expectation_conflict",
  "job_filter_confirmation_not_allowed",
  "job_filter_readback_mismatch",
  "job_extraction_not_allowed",
  "job_match_selection_not_allowed",
  "job_match_conflict_confirmation_required",
  "job_match_conflict_confirmation_not_required",
  "job_match_conflict_confirmation_stale",
  "job_match_result_not_found",
  "job_match_result_stale",
  "job_match_result_version_conflict",
  "job_match_posting_changed",
  "job_match_conversion_not_allowed",
  "job_match_submission_invariant_violated",
  "browser_lease_in_use",
  "browser_task_in_use"
]);
