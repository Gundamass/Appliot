import Fastify from "fastify";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationJobMatchActionResult } from "@resume/contracts";
import { createApp } from "../app.js";
import { migrateDatabase } from "../db/migrate.js";
import { createProfileRepository } from "../profile/profile-repository.js";
import { registerConversationJobMatchRoutes } from "./conversation-job-match-routes.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

function harness() {
  const result: ConversationJobMatchActionResult = {
    sessionId: "33333333-3333-4333-8333-333333333333",
    state: "awaiting_job_selection",
    version: 4,
    turnSequence: 3,
    message: {
      id: "77777777-7777-4777-8777-777777777777",
      sessionId: "11111111-1111-4111-8111-111111111111",
      sequence: 4,
      role: "assistant",
      text: "岗位推荐已准备好。",
      cards: [],
      createdAt: "2026-09-02T00:00:00.000Z"
    },
    cards: [],
    context: { version: 1, recentPostingIds: [], activeJobMatchSessionId: "33333333-3333-4333-8333-333333333333" }
  };
  const service = {
    execute: vi.fn(async () => result),
    findOwningConversation: vi.fn(async () => ({ conversationId: "11111111-1111-4111-8111-111111111111" }))
  };
  const app = Fastify({ logger: false });
  apps.push(app);
  registerConversationJobMatchRoutes(app, { service: service as never });
  return { app, service, result };
}

describe("conversation job-match routes", () => {
  it("dispatches a guarded action and returns the action result", async () => {
    const value = harness();
    const payload = {
      conversationId: "11111111-1111-4111-8111-111111111111",
      sessionId: "33333333-3333-4333-8333-333333333333",
      action: "pause",
      sessionVersion: 3,
      idempotencyKey: "pause-1"
    };

    const response = await value.app.inject({
      method: "POST",
      url: "/api/conversations/11111111-1111-4111-8111-111111111111/job-match-actions",
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(value.result);
    expect(value.service.execute).toHaveBeenCalledWith(payload.conversationId, payload);
  });

  it("rejects a body conversation mismatch before dispatch", async () => {
    const value = harness();
    const response = await value.app.inject({
      method: "POST",
      url: "/api/conversations/11111111-1111-4111-8111-111111111111/job-match-actions",
      payload: {
        conversationId: "22222222-2222-4222-8222-222222222222",
        sessionId: "33333333-3333-4333-8333-333333333333",
        action: "pause",
        sessionVersion: 3,
        idempotencyKey: "pause-1"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "conversation_job_match_conversation_mismatch" });
    expect(value.service.execute).not.toHaveBeenCalled();
  });

  it("maps ownership, version and unknown failures without exposing raw errors", async () => {
    const value = harness();
    value.service.execute.mockRejectedValueOnce(new Error("conversation_job_match_not_owned"));
    const ownership = await value.app.inject({
      method: "POST",
      url: "/api/conversations/11111111-1111-4111-8111-111111111111/job-match-actions",
      payload: {
        conversationId: "11111111-1111-4111-8111-111111111111",
        sessionId: "33333333-3333-4333-8333-333333333333",
        action: "pause",
        sessionVersion: 3,
        idempotencyKey: "pause-2"
      }
    });
    expect(ownership.statusCode).toBe(403);
    expect(ownership.json()).toMatchObject({ code: "conversation_job_match_not_owned" });

    value.service.execute.mockRejectedValueOnce(new Error("job_match_version_conflict"));
    const version = await value.app.inject({
      method: "POST",
      url: "/api/conversations/11111111-1111-4111-8111-111111111111/job-match-actions",
      payload: {
        conversationId: "11111111-1111-4111-8111-111111111111",
        sessionId: "33333333-3333-4333-8333-333333333333",
        action: "pause",
        sessionVersion: 3,
        idempotencyKey: "pause-3"
      }
    });
    expect(version.statusCode).toBe(409);

    value.service.execute.mockRejectedValueOnce(new Error("browser_worker cookie=secret"));
    const unknown = await value.app.inject({
      method: "POST",
      url: "/api/conversations/11111111-1111-4111-8111-111111111111/job-match-actions",
      payload: {
        conversationId: "11111111-1111-4111-8111-111111111111",
        sessionId: "33333333-3333-4333-8333-333333333333",
        action: "pause",
        sessionVersion: 3,
        idempotencyKey: "pause-4"
      }
    });
    expect(unknown.statusCode).toBe(500);
    expect(JSON.stringify(unknown.json())).not.toContain("cookie=secret");
  });

  it("returns the owning conversation for legacy job-match links", async () => {
    const value = harness();
    const response = await value.app.inject({
      method: "GET",
      url: "/api/job-match-sessions/33333333-3333-4333-8333-333333333333/conversation"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ conversationId: "11111111-1111-4111-8111-111111111111" });
    expect(value.service.findOwningConversation).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333");
  });

  it("is registered by the application composition", async () => {
    const value = harness();
    const database = new Database(":memory:");
    migrateDatabase(database);
    const app = await createApp({
      database,
      profileRepository: createProfileRepository(database),
      originalDocumentStore: {} as never,
      extractPdf: vi.fn(),
      extractFacts: vi.fn(),
      conversationJobMatchService: value.service as never,
      close: () => database.close()
    } as never);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/conversations/11111111-1111-4111-8111-111111111111/job-match-actions",
      payload: {
        conversationId: "11111111-1111-4111-8111-111111111111",
        sessionId: "33333333-3333-4333-8333-333333333333",
        action: "pause",
        sessionVersion: 3,
        idempotencyKey: "composition-1"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(value.service.execute).toHaveBeenCalledOnce();
  });
});
