import { describe, expect, it, vi } from "vitest";
import {
  ConversationContextSchema,
  ConversationMessageSchema,
  ConversationSessionSchema,
  type ConversationConfirmation,
  type ConversationContext
} from "@resume/contracts";
import { createConversationService } from "./conversation-service.js";

describe("conversation service confirmation input", () => {
  it("passes the selected recruitment URL to the graph and keeps it in the idempotency boundary", async () => {
    const session = ConversationSessionSchema.parse({
      id: "conversation-1",
      title: "求职对话",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z"
    });
    const context = ConversationContextSchema.parse({ version: 0, recentPostingIds: [] });
    const pending: ConversationConfirmation = {
      confirmationId: "confirmation-choices",
      action: "confirm_recruitment_site",
      target: {
        kind: "recruitment_site_choices",
        company: "百度",
        recruitmentType: "campus",
        query: "百度 校园招聘 招聘 官网",
        candidates: [{
          title: "百度招聘",
          url: "https://jobs.baidu.com/",
          domain: "jobs.baidu.com",
          snippet: "招聘岗位",
          source: "tavily"
        }]
      }
    };
    const graph = {
      invoke: vi.fn(async (input: {
        conversationId: string;
        context: ConversationContext;
        confirmationId?: string;
        approved?: boolean;
        selectedUrl?: string;
      }) => {
        const nextContext = ConversationContextSchema.parse({ ...input.context, version: 1 });
        const message = ConversationMessageSchema.parse({
          id: "assistant-1",
          sessionId: input.conversationId,
          sequence: 1,
          role: "assistant",
          text: "招聘入口已确认。",
          cards: [],
          createdAt: "2026-08-24T00:00:00.000Z"
        });
        return {
          response: { message, cards: [], context: nextContext },
          context: nextContext,
          traceIds: []
        };
      })
    };
    const appendTurn = vi.fn((input: { response: unknown }) => ({ response: input.response }));
    const repository = {
      getConversation: vi.fn(() => session),
      listMessages: vi.fn(() => []),
      getContext: vi.fn(() => context),
      getTurn: vi.fn(() => undefined),
      peekConfirmation: vi.fn(() => pending),
      appendTurn,
      putConfirmation: vi.fn(),
      consumeConfirmation: vi.fn()
    };
    const service = createConversationService({ repository: repository as never, graph: graph as never });

    await service.confirm("conversation-1", {
      confirmationId: pending.confirmationId,
      approved: true,
      selectedUrl: "https://jobs.baidu.com/"
    });

    expect(graph.invoke).toHaveBeenCalledWith(expect.objectContaining({
      confirmationId: pending.confirmationId,
      approved: true,
      selectedUrl: "https://jobs.baidu.com/"
    }), expect.anything());
    expect(appendTurn).toHaveBeenCalledWith(expect.objectContaining({
      requestId: expect.stringContaining("confirmation-choices:approved:")
    }));
  });
});
