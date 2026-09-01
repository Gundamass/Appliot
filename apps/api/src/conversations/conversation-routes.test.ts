import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationContextSchema,
  ConversationMessageSchema,
  ConversationSessionSchema,
  type ConversationContext,
  type ConversationSession
} from "@resume/contracts";
import { createApp } from "../app.js";
import { migrateDatabase } from "../db/migrate.js";
import { createAdapterHealthRegistry } from "../health/adapter-health.js";
import { createLocalOriginalDocumentStore } from "../profile/original-document-store.js";
import { createProfileRepository } from "../profile/profile-repository.js";
import { createConversationRepository } from "./conversation-repository.js";
import { createConversationProcessEventBus, type ConversationProcessEventBus } from "./conversation-events.js";
import {
  createConversationService,
  type ConversationService
} from "./conversation-service.js";
import type { ConversationGraphInput, ConversationGraphOutput } from "./conversation-graph.js";

const resources: Array<{
  app: Awaited<ReturnType<typeof createApp>>;
  database: InstanceType<typeof Database>;
  storageRoot: string;
}> = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    await resource.app.close();
    resource.database.close();
    await rm(resource.storageRoot, { recursive: true, force: true });
  }
});

describe("conversation routes", () => {
  it("rejects oversized and malformed message bodies", async () => {
    const service = fakeService();
    const app = await buildApp(service);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/conversations/session-1/messages",
      payload: { text: "x".repeat(501) }
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/api/conversations/session-1/messages",
      payload: { text: "ok", extra: "reject-me" }
    });

    expect(oversized.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(service.send).not.toHaveBeenCalled();
  });

  it("requires the confirmation token for task creation", async () => {
    const service = fakeService();
    service.confirm.mockRejectedValue(new Error("conversation_confirmation_invalid"));
    const app = await buildApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/conversations/session-1/confirm",
      payload: { confirmationId: "wrong", approved: true }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "conversation_confirmation_invalid" });
    expect(service.confirm).toHaveBeenCalledWith("session-1", {
      confirmationId: "wrong",
      approved: true
    });
  });

  it("passes the selected recruitment URL through the confirmation route", async () => {
    const service = fakeService();
    const app = await buildApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/conversations/session-1/confirm",
      payload: {
        confirmationId: "confirmation-choices",
        approved: true,
        selectedUrl: "https://jobs.baidu.com/"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(service.confirm).toHaveBeenCalledWith("session-1", {
      confirmationId: "confirmation-choices",
      approved: true,
      selectedUrl: "https://jobs.baidu.com/"
    });
  });

  it("creates a session and returns its history and context", async () => {
    const service = fakeService();
    const app = await buildApp(service);

    const created = await app.inject({ method: "POST", url: "/api/conversations" });
    const view = await app.inject({ method: "GET", url: "/api/conversations/session-1" });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual(service.session);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      session: service.session,
      messages: [],
      context: { version: 0, recentPostingIds: [] }
    });
  });

  it("persists a turn and replays the same idempotency key without a second graph run", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createConversationRepository(database);
    const graph = fakeGraph();
    const service = createConversationService({ repository, graph });
    const app = await buildApp(service, database);

    const session = (await app.inject({ method: "POST", url: "/api/conversations" })).json() as ConversationSession;
    const first = await app.inject({
      method: "POST",
      url: `/api/conversations/${session.id}/messages`,
      headers: { "idempotency-key": "request-1" },
      payload: { text: "show my applications" }
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/conversations/${session.id}/messages`,
      headers: { "idempotency-key": "request-1" },
      payload: { text: "show my applications" }
    });
    const view = await app.inject({ method: "GET", url: `/api/conversations/${session.id}` });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(graph.invoke).toHaveBeenCalledOnce();
    expect(view.json().messages).toHaveLength(2);
  });

  it("restores a pending confirmation after the service is rebuilt and consumes it once", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createConversationRepository(database);
    const firstGraph = fakeGraph({ pendingConfirmation: true });
    const firstService = createConversationService({ repository, graph: firstGraph });
    const firstApp = await buildApp(firstService, database);
    const session = (await firstApp.inject({ method: "POST", url: "/api/conversations" })).json() as ConversationSession;
    const pending = await firstApp.inject({
      method: "POST",
      url: `/api/conversations/${session.id}/messages`,
      payload: { text: "start the first application" }
    });
    const confirmationId = pending.json().confirmationId as string;

    await firstApp.close();
    const secondGraph = fakeGraph({ confirmed: true });
    const secondService = createConversationService({ repository, graph: secondGraph });
    const secondApp = await buildApp(secondService, database);
    const confirmed = await secondApp.inject({
      method: "POST",
      url: `/api/conversations/${session.id}/confirm`,
      payload: { confirmationId, approved: true }
    });
    const replayedConfirmation = await secondApp.inject({
      method: "POST",
      url: `/api/conversations/${session.id}/confirm`,
      payload: { confirmationId, approved: true }
    });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().consumedConfirmationId).toBe(confirmationId);
    expect(secondGraph.invoke).toHaveBeenCalledOnce();
    expect(replayedConfirmation.statusCode).toBe(409);
  });

  it("maps unavailable graph dependencies to 503 without exposing raw errors", async () => {
    const service = fakeService();
    service.send.mockRejectedValue(new Error("conversation_graph_unavailable"));
    const app = await buildApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/conversations/session-1/messages",
      payload: { text: "show recommendations" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Conversation service unavailable",
      code: "conversation_service_unavailable"
    });
    expect(JSON.stringify(response.json())).not.toContain("conversation_graph_unavailable");
  });

  it("replays process events after Last-Event-ID and streams future events", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createConversationRepository(database);
    const session = repository.createConversation();
    const service = fakeService();
    vi.mocked(service.get).mockReturnValue({
      session,
      messages: [],
      context: ConversationContextSchema.parse({ version: 0 })
    });
    const processEvents = createConversationProcessEventBus(database);
    const first = processEvents.emit({
      conversationId: session.id,
      turnSequence: 1,
      stepId: "understanding-request",
      stage: "understanding_request",
      status: "running",
      summary: "正在理解你的请求"
    });
    const second = processEvents.emit({
      conversationId: session.id,
      turnSequence: 1,
      stepId: "completed",
      stage: "completed",
      status: "completed",
      summary: "本轮处理已完成"
    });
    const app = await buildApp(service, database, processEvents);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const abort = new AbortController();
    const response = await fetch(`${address}/api/conversations/${session.id}/events`, {
      headers: { "Last-Event-ID": first.id },
      signal: abort.signal
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const replay = await readUntil(reader, (text) => text.includes(`id: ${second.id}\n`));
    expect(replay).not.toContain(`id: ${first.id}\n`);

    const future = processEvents.emit({
      conversationId: session.id,
      turnSequence: 1,
      stepId: "failed",
      stage: "failed",
      status: "failed",
      summary: "本轮处理失败",
      failure: {
        code: "PROCESS_FAILED",
        summary: "本轮处理失败",
        retryable: true
      }
    });
    const futureFrame = await readUntil(reader, (text) => text.includes(`id: ${future.id}\n`));
    expect(futureFrame).toContain('"stage":"failed"');

    abort.abort();
    await reader.cancel().catch(() => undefined);
    await waitFor(() => processEvents.subscriberCount(session.id) === 0);
  });
});

function fakeService() {
  const session = ConversationSessionSchema.parse({
    id: "session-1",
    title: "New conversation",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z"
  });
  const context = ConversationContextSchema.parse({ version: 0 });
  const service = {
    session,
    create: vi.fn(() => session),
    get: vi.fn(() => ({ session, messages: [], context })),
    send: vi.fn(async () => graphOutput("session-1", context)),
    confirm: vi.fn(async () => graphOutput("session-1", context))
  } satisfies Record<string, unknown>;
  return service as typeof service & ConversationService;
}

function fakeGraph(options: { pendingConfirmation?: boolean; confirmed?: boolean } = {}) {
  return {
    invoke: vi.fn(async (input: ConversationGraphInput) => {
      const context = ConversationContextSchema.parse(input.context);
      const nextContext = ConversationContextSchema.parse({
        ...context,
        version: context.version + 1
      });
      return graphOutput(input.conversationId, nextContext, {
        pendingConfirmation: options.pendingConfirmation === true && input.confirmationId === undefined,
        confirmed: options.confirmed === true && input.confirmationId !== undefined,
        ...(input.sequence === undefined ? {} : { sequence: input.sequence })
      });
    })
  };
}

function graphOutput(
  conversationId: string,
  context: ConversationContext,
  options: { pendingConfirmation?: boolean; confirmed?: boolean; sequence?: number } = {}
): ConversationGraphOutput {
  const confirmationId = options.pendingConfirmation === true ? "confirmation-1" : undefined;
  const message = ConversationMessageSchema.parse({
    id: `assistant-${context.version}`,
    sessionId: conversationId,
    sequence: (options.sequence ?? context.version) + 1,
    role: "assistant",
    text: options.confirmed === true ? "Application task created." : "Here is the current status.",
    cards: [],
    createdAt: "2026-08-22T00:00:00.000Z"
  });
  return {
    response: {
      message,
      cards: [],
      context,
      ...(confirmationId === undefined ? {} : {
        confirmationId,
        pendingConfirmation: {
          confirmationId,
          action: "start_application",
          target: { kind: "recommendation", sessionId: "match-1", resultId: "result-1" }
        }
      }),
      ...(options.confirmed === true ? { consumedConfirmationId: "confirmation-1" } : {})
    },
    context,
    traceIds: []
  };
}

async function buildApp(
  conversationService: ConversationService,
  existingDatabase?: InstanceType<typeof Database>,
  processEvents?: ConversationProcessEventBus
) {
  const database = existingDatabase ?? new Database(":memory:");
  if (existingDatabase === undefined) migrateDatabase(database);
  const storageRoot = await mkdtemp(join(tmpdir(), "resume-conversation-routes-"));
  const app = await createApp({
    database,
    adapterHealth: createAdapterHealthRegistry(),
    profileRepository: createProfileRepository(database),
    originalDocumentStore: createLocalOriginalDocumentStore(storageRoot),
    extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }),
    extractFacts: async () => [],
    conversationService,
    ...(processEvents === undefined ? {} : { conversationProcessEvents: processEvents })
  } as never);
  resources.push({ app, database, storageRoot });
  return app;
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 1_000
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!predicate(text)) {
    if (Date.now() >= deadline) throw new Error(`stream_timeout: ${text}`);
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("stream_timeout")), 100))
    ]);
    if (result.done) throw new Error(`stream_ended: ${text}`);
    text += decoder.decode(result.value, { stream: true });
  }
  return text;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
