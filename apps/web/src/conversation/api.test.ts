import {
  ConversationSessionSchema,
  ConversationTurnResponseSchema,
  ConversationViewSchema,
  type ConversationSession,
  type ConversationTurnResponse
} from "@resume/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationApiError, createConversationApi } from "./api.js";

const session: ConversationSession = ConversationSessionSchema.parse({
  id: "conversation-1",
  title: "新的求职对话",
  createdAt: "2026-08-23T01:00:00.000Z",
  updatedAt: "2026-08-23T01:00:00.000Z"
});

const turn: ConversationTurnResponse = ConversationTurnResponseSchema.parse({
  message: {
    id: "message-2",
    sessionId: session.id,
    sequence: 2,
    role: "assistant",
    text: "可以开始岗位匹配",
    cards: [],
    createdAt: "2026-08-23T01:01:00.000Z"
  },
  cards: [],
  context: { version: 1, recentPostingIds: [] }
});

const view = ConversationViewSchema.parse({
  session,
  messages: [turn.message],
  context: { version: 1, recentPostingIds: [] }
});

afterEach(() => vi.unstubAllGlobals());

describe("ConversationApi", () => {
  it("lists and deletes server-managed conversations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([session]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(response({ deletedCount: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createConversationApi("/gateway");

    await expect(api.list()).resolves.toEqual([session]);
    await expect(api.delete("conversation/1")).resolves.toBeUndefined();
    await expect(api.deleteAll()).resolves.toEqual({ deletedCount: 1 });

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["/gateway/api/conversations", "GET"],
      ["/gateway/api/conversations/conversation%2F1", "DELETE"],
      ["/gateway/api/conversations", "DELETE"]
    ]);
  });

  it("rejects invalid list and clear payloads through shared contracts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{ ...session, extra: true }]))
      .mockResolvedValueOnce(response({ deletedCount: -1 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createConversationApi();

    await expect(api.list()).rejects.toThrow();
    await expect(api.deleteAll()).rejects.toThrow();
  });

  it("maps a failed delete to ConversationApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      response({ error: "会话不存在", code: "conversation_not_found" }, 404)
    ));
    const api = createConversationApi();

    await expect(api.delete("missing")).rejects.toMatchObject({
      name: "ConversationApiError",
      message: "会话不存在",
      code: "conversation_not_found",
      status: 404
    } satisfies Partial<ConversationApiError>);
  });

  it("parses session, history, and turn responses through the shared contracts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(view), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(turn), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createConversationApi("/gateway");

    await expect(api.create()).resolves.toEqual(session);
    await expect(api.get(session.id)).resolves.toEqual(view);
    await expect(api.send(session.id, "推荐适合我的岗位")).resolves.toEqual(turn);

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["/gateway/api/conversations", "POST"],
      ["/gateway/api/conversations/conversation-1", "GET"],
      ["/gateway/api/conversations/conversation-1/messages", "POST"]
    ]);
  });

  it("rejects an oversized message before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const api = createConversationApi();

    await expect(api.send(session.id, "x".repeat(501))).rejects.toThrow("消息最多 500 字");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps bounded server errors to ConversationApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "会话不存在", code: "conversation_not_found" }), { status: 404 })));
    const api = createConversationApi();

    await expect(api.get("missing")).rejects.toMatchObject({
      name: "ConversationApiError",
      message: "会话不存在",
      code: "conversation_not_found",
      status: 404
    } satisfies Partial<ConversationApiError>);
  });
});

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}
