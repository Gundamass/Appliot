import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationContextSchema,
  ConversationMessageSchema,
  ConversationSessionSchema,
  type ConversationConfirmation,
  type ConversationContext
} from "@resume/contracts";
import { createConversationService } from "./conversation-service.js";
import { migrateDatabase } from "../db/migrate.js";
import { createConversationRepository } from "./conversation-repository.js";

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
    expect(graph.invoke.mock.calls.at(-1)?.[0]).not.toHaveProperty("confirmationSourceTurnSequence");
  });

  it("passes explicit turn ownership for text and confirmation turns", async () => {
    const session = ConversationSessionSchema.parse({
      id: "conversation-turns",
      title: "对话轮次",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z"
    });
    const context = ConversationContextSchema.parse({ version: 0, recentPostingIds: [] });
    const pending: ConversationConfirmation = {
      confirmationId: "confirmation-turns",
      action: "request_job_recommendations",
      sourceTurnSequence: 1,
      target: {
        kind: "recruitment_site",
        company: "百度",
        recruitmentType: "campus",
        query: "百度 校园招聘 官方",
        title: "百度校园招聘",
        url: "https://campus.baidu.com/",
        domain: "campus.baidu.com",
        snippet: "校园招聘岗位",
        source: "tavily"
      }
    };
    const responseFor = (input: { conversationId: string; context: ConversationContext }) => {
      const nextContext = ConversationContextSchema.parse({ ...input.context, version: input.context.version + 1 });
      const message = ConversationMessageSchema.parse({
        id: `assistant-${input.context.version + 1}`,
        sessionId: input.conversationId,
        sequence: 1,
        role: "assistant",
        text: "已处理",
        cards: [],
        createdAt: "2026-08-24T00:00:00.000Z"
      });
      return {
        response: { message, cards: [], context: nextContext },
        context: nextContext,
        traceIds: []
      };
    };
    const graph = { invoke: vi.fn(async (input: { conversationId: string; context: ConversationContext }) => responseFor(input)) };
    const messages: Array<{ sequence: number }> = [];
    const appendTurn = vi.fn((input: { response: unknown }) => {
      if (messages.length === 0) messages.push({ sequence: 1 }, { sequence: 2 });
      return { response: input.response };
    });
    const repository = {
      getConversation: vi.fn(() => session),
      listMessages: vi.fn(() => messages),
      getContext: vi.fn(() => context),
      getTurn: vi.fn(() => undefined),
      peekConfirmation: vi.fn(() => pending),
      appendTurn,
      putConfirmation: vi.fn(),
      consumeConfirmation: vi.fn()
    };
    const service = createConversationService({ repository: repository as never, graph: graph as never });

    await service.send(session.id, "帮我投递百度校园招聘");
    expect(graph.invoke).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: session.id,
      text: "帮我投递百度校园招聘",
      turnSequence: 1,
      sequence: 1
    }), expect.anything());

    await service.confirm(session.id, { confirmationId: pending.confirmationId, approved: true });
    expect(graph.invoke).toHaveBeenLastCalledWith(expect.objectContaining({
      confirmationId: pending.confirmationId,
      turnSequence: 3,
      sequence: 3,
      confirmationSourceTurnSequence: 1
    }), expect.anything());
  });

  it("returns the most recent pending confirmation when loading a conversation", async () => {
    const database = new Database(":memory:");
    try {
      migrateDatabase(database);
      const repository = createConversationRepository(database);
      const session = repository.createConversation();
      const pending: ConversationConfirmation = {
        confirmationId: "confirmation-restored",
        action: "request_job_recommendations",
        target: {
          kind: "recruitment_site",
          company: "Baidu",
          recruitmentType: "campus",
          query: "Baidu campus recruitment official",
          title: "Baidu Campus Recruitment",
          url: "https://campus.baidu.com/",
          domain: "campus.baidu.com",
          snippet: "Campus recruitment roles",
          source: "tavily"
        }
      };
      const graph = {
        invoke: vi.fn(async (input: { conversationId: string; context: ConversationContext }) => {
          const context = ConversationContextSchema.parse({ ...input.context, version: input.context.version + 1 });
          const message = ConversationMessageSchema.parse({
            id: "assistant-restore",
            sessionId: input.conversationId,
            sequence: 1,
            role: "assistant",
            text: "Recruitment entry confirmed.",
            cards: [],
            createdAt: "2026-08-24T00:00:00.000Z"
          });
          return {
            response: { message, cards: [], context, pendingConfirmation: pending, confirmationId: pending.confirmationId },
            context,
            traceIds: []
          };
        })
      };
      const service = createConversationService({ repository, graph: graph as never });

      await service.send(session.id, "帮我投递百度");

      expect(service.get(session.id)).toMatchObject({ pendingConfirmation: pending });
    } finally {
      database.close();
    }
  });

  it("hydrates a legacy confirmation card with the pending confirmation ID", () => {
    const database = new Database(":memory:");
    try {
      migrateDatabase(database);
      const repository = createConversationRepository(database);
      const session = repository.createConversation();
      const pending: ConversationConfirmation = {
        confirmationId: "confirmation-legacy-card",
        action: "request_job_recommendations",
        target: {
          kind: "recruitment_site",
          company: "Baidu",
          recruitmentType: "campus",
          query: "Baidu campus recruitment official",
          title: "Baidu Campus Recruitment",
          url: "https://campus.baidu.com/",
          domain: "campus.baidu.com",
          snippet: "Campus recruitment roles",
          source: "tavily"
        }
      };
      repository.putConfirmation(session.id, pending);
      repository.appendMessage({
        sessionId: session.id,
        expectedSequence: 0,
        message: ConversationMessageSchema.parse({
          id: "assistant-legacy-confirmation",
          sessionId: session.id,
          sequence: 1,
          role: "assistant",
          text: "Recruitment entry confirmed.",
          cards: [{ type: "confirmation", action: pending.action, target: pending.target }],
          createdAt: "2026-08-24T00:00:00.000Z"
        })
      });
      const service = createConversationService({
        repository,
        graph: { invoke: vi.fn() } as never
      });

      const view = service.get(session.id);

      expect(view.messages[0]?.cards[0]).toMatchObject({
        type: "confirmation",
        confirmationId: pending.confirmationId
      });
    } finally {
      database.close();
    }
  });

  it("persists a follow-up confirmation after the previous one is approved", async () => {
    const database = new Database(":memory:");
    try {
      migrateDatabase(database);
      const repository = createConversationRepository(database);
      const session = repository.createConversation();
      const initial: ConversationConfirmation = {
        confirmationId: "confirmation-entry",
        action: "confirm_recruitment_site",
        target: {
          kind: "recruitment_site_choices",
          company: "Baidu",
          recruitmentType: "campus",
          query: "Baidu campus recruitment official",
          candidates: [{
            title: "Baidu Campus Recruitment",
            url: "https://campus.baidu.com/",
            domain: "campus.baidu.com",
            snippet: "Campus recruitment roles",
            source: "tavily"
          }]
        }
      };
      const followUp: ConversationConfirmation = {
        confirmationId: "confirmation-recommendations",
        action: "request_job_recommendations",
        target: {
          kind: "recruitment_site",
          company: "Baidu",
          recruitmentType: "campus",
          query: "Baidu campus recruitment official",
          title: "Baidu Campus Recruitment",
          url: "https://campus.baidu.com/",
          domain: "campus.baidu.com",
          snippet: "Campus recruitment roles",
          source: "tavily"
        }
      };
      repository.putConfirmation(session.id, initial);
      const graph = {
        invoke: vi.fn(async (input: { conversationId: string; context: ConversationContext }) => {
          const context = ConversationContextSchema.parse({ ...input.context, version: input.context.version + 1 });
          const message = ConversationMessageSchema.parse({
            id: "assistant-follow-up",
            sessionId: input.conversationId,
            sequence: 2,
            role: "assistant",
            text: "Recruitment entry confirmed.",
            cards: [],
            createdAt: "2026-08-24T00:00:00.000Z"
          });
          return {
            response: { message, cards: [], context, pendingConfirmation: followUp, confirmationId: followUp.confirmationId },
            context,
            traceIds: []
          };
        })
      };
      const service = createConversationService({ repository, graph: graph as never });

      await service.confirm(session.id, { confirmationId: initial.confirmationId, approved: true });

      expect(service.get(session.id)).toMatchObject({ pendingConfirmation: followUp });
    } finally {
      database.close();
    }
  });
});
