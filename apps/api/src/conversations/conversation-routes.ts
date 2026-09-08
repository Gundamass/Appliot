import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ConversationProcessEventSchema,
  ConversationProcessHistoryResetSchema,
  ConversationHistoryClearResultSchema,
  ConversationSessionListSchema,
  ConversationSessionSchema,
  ConversationConfirmInputSchema,
  ConversationTurnInputSchema,
  ConversationTurnResponseSchema,
  ConversationViewSchema
} from "@resume/contracts";
import { z } from "zod";
import { sendError } from "../http-response.js";
import type { ConversationService } from "./conversation-service.js";
import type { ConversationProcessEvent, ConversationProcessHistoryReset } from "@resume/contracts";
import type { ConversationProcessEventBus } from "./conversation-events.js";

const ConversationParamsSchema = z.object({ id: z.string().min(1).max(256) }).strict();
const IdempotencyKeySchema = z.string().trim().min(1).max(256);

export interface ConversationRouteDependencies {
  service: ConversationService;
  processEvents?: ConversationProcessEventBus;
  sseHeartbeatMs?: number;
}

export function registerConversationRoutes(
  app: FastifyInstance,
  dependencies: ConversationRouteDependencies
): void {
  app.post("/api/conversations", async (_request, reply) => {
    return execute(reply, 201, () => ConversationSessionSchema.parse(dependencies.service.create()));
  });

  app.get("/api/conversations", async (_request, reply) => {
    return execute(reply, 200, () => ConversationSessionListSchema.parse(dependencies.service.list()));
  });

  app.delete("/api/conversations", async (_request, reply) => {
    return execute(reply, 200, () => ConversationHistoryClearResultSchema.parse(dependencies.service.deleteAll()));
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

  app.delete("/api/conversations/:id", async (request, reply) => {
    const params = ConversationParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, "invalid_conversation_id");
    try {
      dependencies.service.delete(params.data.id);
      return reply.code(204).send();
    } catch (error) {
      const mapped = mapConversationError(error);
      return sendError(reply, mapped.statusCode, mapped.error, mapped.code);
    }
  });

  app.post("/api/conversations/:id/confirm", async (request, reply) => {
    const params = ConversationParamsSchema.safeParse(request.params);
    const input = ConversationConfirmInputSchema.safeParse(request.body);
    if (!params.success) return invalid(reply, "invalid_conversation_id");
    if (!input.success) return invalid(reply, "invalid_conversation_confirmation_input");
    return execute(reply, 200, () => dependencies.service.confirm(params.data.id, input.data));
  });

  app.get("/api/conversations/:id/events", async (request, reply) => {
    const params = ConversationParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, "invalid_conversation_id");
    if (dependencies.processEvents === undefined) {
      return sendError(reply, 503, "Conversation process events unavailable", "conversation_process_events_unavailable");
    }
    try {
      dependencies.service.get(params.data.id);
    } catch (error) {
      const mapped = mapConversationError(error);
      return sendError(reply, mapped.statusCode, mapped.error, mapped.code);
    }

    const lastEventId = request.headers["last-event-id"];
    const afterId = typeof lastEventId === "string" && /^\d+$/u.test(lastEventId) ? lastEventId : undefined;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no"
    });
    reply.raw.flushHeaders();

    let closed = false;
    const writeEvent = (event: ConversationProcessEvent): void => {
      if (!closed && !reply.raw.destroyed) reply.raw.write(formatProcessSseEvent(event));
    };
    let replaying = true;
    const bufferedEvents: ConversationProcessEvent[] = [];
    const unsubscribe = dependencies.processEvents.subscribe(params.data.id, (event) => {
      if (replaying) bufferedEvents.push(event);
      else writeEvent(event);
    });
    const replay = dependencies.processEvents.replay(params.data.id, afterId);
    if (replay.reset !== undefined && !closed && !reply.raw.destroyed) {
      reply.raw.write(formatHistoryReset(replay.reset));
    }
    const replayEvents = replay.events;
    const replayIds = new Set<string>();
    for (const event of [...replayEvents, ...bufferedEvents].sort(compareProcessEventIds)) {
      if (replayIds.has(event.id)) continue;
      replayIds.add(event.id);
      writeEvent(event);
    }
    replaying = false;
    const heartbeat = setInterval(() => {
      if (!closed && !reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, dependencies.sseHeartbeatMs ?? 15_000);
    heartbeat.unref();
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.once("close", cleanup);
    reply.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
    return reply;
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

function formatProcessSseEvent(event: ConversationProcessEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(ConversationProcessEventSchema.parse(event))}\n\n`;
}

function formatHistoryReset(event: ConversationProcessHistoryReset): string {
  return `event: history_reset\ndata: ${JSON.stringify(ConversationProcessHistoryResetSchema.parse(event))}\n\n`;
}

function compareProcessEventIds(left: ConversationProcessEvent, right: ConversationProcessEvent): number {
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
