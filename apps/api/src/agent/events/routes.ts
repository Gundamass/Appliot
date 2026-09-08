import {
  AgentRunInputSchema,
  AgentRunResultSchema,
  RuntimeHumanResumeSchema,
  RuntimeSnapshotSchema,
  type AgentRunResult,
  type AgentEvent
} from "@resume/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendError } from "../../http-response.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import { formatAgentSseEvent } from "./event-projector.js";
import type { AgentEventTraceSink } from "./trace-sink.js";

const RunParamsSchema = z.object({ runId: z.string().min(1).max(128) }).strict();
const EventQuerySchema = z.object({ after: z.string().min(1).max(256).optional() }).strict();

export interface AgentRuntimeRouteDependencies {
  readonly runtime: AgentRuntime;
  readonly events: AgentEventTraceSink;
  readonly sseHeartbeatMs?: number;
}

export function registerAgentRuntimeRoutes(
  app: FastifyInstance,
  dependencies: AgentRuntimeRouteDependencies
): void {
  app.post("/api/agent/runs", async (request, reply) => {
    const parsed = AgentRunInputSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "Invalid agent run input", "invalid_agent_run_input");
    try {
      const result = AgentRunResultSchema.parse(await dependencies.runtime.start(parsed.data));
      const enriched = publishLifecycle(dependencies.events, result, "start");
      return reply.code(201).send(enriched);
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.get("/api/agent/runs/:runId", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "Invalid agent run id", "invalid_agent_run_id");
    try {
      return reply.code(200).send(RuntimeSnapshotSchema.parse(await dependencies.runtime.inspect(params.data.runId)));
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.post("/api/agent/runs/:runId/resume", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    const input = RuntimeHumanResumeSchema.safeParse(request.body);
    if (!params.success) return sendError(reply, 400, "Invalid agent run id", "invalid_agent_run_id");
    if (!input.success) return sendError(reply, 400, "Invalid agent resume input", "invalid_agent_resume_input");
    try {
      const previousEventIds = new Set(dependencies.events.list(params.data.runId).map((event) => event.eventId));
      const result = AgentRunResultSchema.parse(await dependencies.runtime.resume(params.data.runId, input.data));
      const enriched = publishLifecycle(dependencies.events, result, "resume", input.data.action, previousEventIds);
      return reply.code(200).send(enriched);
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.post("/api/agent/runs/:runId/cancel", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "Invalid agent run id", "invalid_agent_run_id");
    try {
      const result = AgentRunResultSchema.parse(await dependencies.runtime.cancel(params.data.runId));
      const enriched = publishLifecycle(dependencies.events, result, "cancel");
      return reply.code(200).send(enriched);
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.get("/api/agent/runs/:runId/events", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    const query = EventQuerySchema.safeParse(request.query);
    if (!params.success) return sendError(reply, 400, "Invalid agent run id", "invalid_agent_run_id");
    if (!query.success) return sendError(reply, 400, "Invalid event cursor", "invalid_agent_event_cursor");
    const after = query.data.after ?? lastEventId(request.headers["last-event-id"]);
    const existing = dependencies.events.list(params.data.runId);
    if (existing.length === 0) return sendError(reply, 404, "Agent run not found", "agent_run_not_found");
    if (acceptsSse(request.headers.accept)) {
      return streamEvents(request, reply, dependencies.events, params.data.runId, after, dependencies.sseHeartbeatMs);
    }
    const replay = dependencies.events.replay(params.data.runId, after);
    return reply.code(200).send(replay);
  });
}

function publishLifecycle(
  events: AgentEventTraceSink,
  result: AgentRunResult,
  operation: "start" | "resume" | "cancel",
  action?: string,
  previousEventIds: ReadonlySet<string> = new Set()
): AgentRunResult {
  const existing = events.list(result.runId);
  const hasType = (type: AgentEvent["type"]) => existing.some((event) => event.type === type);
  const hasNewType = (type: AgentEvent["type"]) => existing.some((event) =>
    event.type === type && !previousEventIds.has(event.eventId)
  );
  if (!hasType("run_started")) {
    events.record({ runId: result.runId, type: "run_started", actor: "runtime", redactionVersion: "v1" });
  }
  if (operation === "resume" && !hasNewType("approval_granted") && !hasNewType("clarification_received")) {
    events.record({
      runId: result.runId,
      type: action === "approve" ? "approval_granted" : "clarification_received",
      actor: "user",
      payloadRef: `run:${result.runId}:resume`,
      redactionVersion: "v1"
    });
  }
  if (result.intentId !== undefined && !hasType("intent_resolved")) {
    events.record({
      runId: result.runId,
      ...(result.intentId === undefined ? {} : { intentId: result.intentId }),
      type: "intent_resolved",
      actor: "runtime",
      payloadRef: `intent:${result.intentId}`,
      redactionVersion: "v1"
    });
  }
  if (result.planId !== undefined && !hasType("plan_created")) {
    events.record({
      runId: result.runId,
      ...(result.intentId === undefined ? {} : { intentId: result.intentId }),
      planId: result.planId,
      ...(result.planRevision === undefined ? {} : { planRevision: result.planRevision }),
      type: "plan_created",
      actor: "runtime",
      payloadRef: `plan:${result.planId}`,
      redactionVersion: "v1"
    });
  }
  if (result.pendingInterrupt !== undefined) {
    const interruptRef = `interrupt:${result.pendingInterrupt.interruptId}`;
    if (!existing.some((event) => event.type === "human_interrupt" && event.payloadRef === interruptRef)) {
      events.record({
        runId: result.runId,
        ...(result.intentId === undefined ? {} : { intentId: result.intentId }),
        ...(result.planId === undefined ? {} : { planId: result.planId }),
        ...(result.planRevision === undefined ? {} : { planRevision: result.planRevision }),
        type: "human_interrupt",
        actor: "runtime",
        payloadRef: interruptRef,
        redactionVersion: "v1"
      });
    }
  }
  const terminalType = result.status === "completed"
    ? "run_completed"
    : result.status === "failed"
      ? "run_failed"
      : result.status === "cancelled"
        ? "run_cancelled"
        : result.status === "expired"
          ? "run_expired"
          : result.status === "blocked" ? "run_blocked" : undefined;
  if (terminalType !== undefined && !hasType(terminalType)) {
    events.record({
      runId: result.runId,
      ...(result.intentId === undefined ? {} : { intentId: result.intentId }),
      ...(result.planId === undefined ? {} : { planId: result.planId }),
      ...(result.planRevision === undefined ? {} : { planRevision: result.planRevision }),
      type: terminalType,
      actor: "runtime",
      ...(result.error?.code === undefined ? {} : { payloadRef: `error:${result.error.code}` }),
      redactionVersion: "v1"
    });
  }
  const replay = events.replay(result.runId);
  return AgentRunResultSchema.parse({
    ...result,
    ...(replay.nextCursor === undefined ? {} : { eventCursor: replay.nextCursor })
  });
}

async function streamEvents(
  request: { raw: { once(event: "close", listener: () => void): unknown } },
  reply: { hijack(): void; raw: { destroyed: boolean; writeHead(statusCode: number, headers: Record<string, string>): void; flushHeaders(): void; write(chunk: string): void; once(event: "close" | "error", listener: () => void): unknown } },
  events: AgentEventTraceSink,
  runId: string,
  after: string | undefined,
  heartbeatMs = 15_000
): Promise<unknown> {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no"
  });
  reply.raw.flushHeaders();
  let closed = false;
  const write = createSseEventWriter(
    (chunk) => reply.raw.write(chunk),
    () => !closed && !reply.raw.destroyed
  );
  let replaying = true;
  const buffered: AgentEvent[] = [];
  const unsubscribe = events.subscribe(runId, (event) => {
    if (replaying) buffered.push(event);
    else write(event);
  });
  const replay = events.replay(runId, after);
  for (const event of [...replay.events, ...buffered]) write(event);
  replaying = false;
  const heartbeat = setInterval(() => {
    if (!closed && !reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
  }, heartbeatMs);
  heartbeat.unref();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.raw.once("close", cleanup);
  reply.raw.once("close", cleanup);
  reply.raw.once("error", cleanup);
  return reply;
}

/**
 * Replay and live subscription can observe the same event during the short
 * handoff between the two. Keep the SSE stream at-least-once for delivery,
 * but never duplicate an event ID within one connection.
 */
export function createSseEventWriter(
  writeChunk: (chunk: string) => void,
  writable: () => boolean = () => true
): (event: AgentEvent) => void {
  const emittedEventIds = new Set<string>();
  return (event) => {
    if (!writable() || emittedEventIds.has(event.eventId)) return;
    emittedEventIds.add(event.eventId);
    writeChunk(formatAgentSseEvent(event));
  };
}

function lastEventId(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

function acceptsSse(value: string | undefined): boolean {
  return value?.split(",").some((item) => item.trim().toLowerCase() === "text/event-stream") ?? false;
}

function sendRuntimeError(reply: Parameters<typeof sendError>[0], error: unknown) {
  const code = error instanceof Error && /^[a-z0-9_:-]{1,120}$/u.test(error.message)
    ? error.message
    : "agent_runtime_failed";
  const status = code === "agent_run_not_found" ? 404 : 409;
  return sendError(reply, status, status === 404 ? "Agent run not found" : "Agent runtime request failed", code);
}
