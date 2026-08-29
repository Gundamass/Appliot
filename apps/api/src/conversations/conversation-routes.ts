import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ConversationSessionSchema,
  ConversationConfirmInputSchema,
  ConversationTurnInputSchema,
  ConversationTurnResponseSchema,
  ConversationViewSchema
} from "@resume/contracts";
import { z } from "zod";
import { sendError } from "../http-response.js";
import type { ConversationService } from "./conversation-service.js";

const ConversationParamsSchema = z.object({ id: z.string().min(1).max(256) }).strict();
const IdempotencyKeySchema = z.string().trim().min(1).max(256);

export interface ConversationRouteDependencies {
  service: ConversationService;
}

export function registerConversationRoutes(
  app: FastifyInstance,
  dependencies: ConversationRouteDependencies
): void {
  app.post("/api/conversations", async (_request, reply) => {
    return execute(reply, 201, () => ConversationSessionSchema.parse(dependencies.service.create()));
  });

  app.get("/api/conversations/:id", async (request, reply) => {
    const params = ConversationParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, "invalid_conversation_id");
    return execute(reply, 200, () => ConversationViewSchema.parse(dependencies.service.get(params.data.id)));
  });

  app.post("/api/conversations/:id/messages", async (request, reply) => {
    const params = ConversationParamsSchema.safeParse(request.params);
    const input = ConversationTurnInputSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_conversation_id");
    if (!input.success) return invalid(reply, "invalid_conversation_message_input");
    const requestId = idempotencyKey(request.headers["idempotency-key"]);
    if (requestId === null) return invalid(reply, "invalid_idempotency_key");
    return execute(reply, 200, () => dependencies.service.send(params.data.id, input.data.text, requestId ?? undefined));
  });

  app.post("/api/conversations/:id/confirm", async (request, reply) => {
    const params = ConversationParamsSchema.safeParse(request.params);
    const input = ConversationConfirmInputSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_conversation_id");
    if (!input.success) return invalid(reply, "invalid_conversation_confirmation_input");
    return execute(reply, 200, () => dependencies.service.confirm(params.data.id, input.data));
  });
}

function idempotencyKey(value: string | string[] | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return null;
  const parsed = IdempotencyKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function execute(
  reply: FastifyReply,
  successStatus: number,
  operation: () => unknown | Promise<unknown>
) {
  try {
    return reply.code(successStatus).send(await operation());
  } catch (error) {
    const mapped = mapConversationError(error);
    return sendError(reply, mapped.statusCode, mapped.error, mapped.code);
  }
}

function invalid(reply: FastifyReply, code: string) {
  return sendError(reply, 400, "Invalid request", code);
}

function mapConversationError(error: unknown): {
  statusCode: number;
  error: string;
  code: string;
} {
  const code = errorCode(error);
  if (code === "conversation_not_found") {
    return { statusCode: 404, error: "Conversation not found", code };
  }
  if (code === "conversation_graph_unavailable" || code === "agent_graph_unavailable") {
    return { statusCode: 503, error: "Conversation service unavailable", code: "conversation_service_unavailable" };
  }
  if (CONFLICT_CODES.has(code)) {
    return { statusCode: 409, error: "Conversation operation conflicts with current state", code };
  }
  if (code.startsWith("conversation_") && code.endsWith("_invalid")) {
    return { statusCode: 400, error: "Invalid request", code };
  }
  return { statusCode: 500, error: "Conversation operation failed", code: "conversation_operation_failed" };
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_:-]+$/u.test(error.message)) return error.message;
  return "conversation_operation_failed";
}

const CONFLICT_CODES = new Set([
  "conversation_confirmation_invalid",
  "conversation_confirmation_conflict",
  "conversation_context_conflict",
  "conversation_context_version_invalid",
  "conversation_idempotency_conflict",
  "conversation_sequence_conflict",
  "conversation_message_mismatch",
  "job_match_posting_changed",
  "job_match_conflict_confirmation_required",
  "job_match_result_stale",
  "recommendation_stale"
]);
