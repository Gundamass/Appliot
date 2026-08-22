import { describe, expect, it } from "vitest";
import {
  ConversationCardSchema,
  ConversationContextSchema,
  ConversationIntentSchema,
  ConversationMessageSchema,
  ConversationSessionSchema,
  ConversationTargetSchema,
  ConversationTurnInputSchema,
  ConversationTurnResponseSchema
} from "./conversation.js";

describe("conversation contracts", () => {
  it("accepts only bounded conversation intents", () => {
    expect(ConversationIntentSchema.parse({
      kind: "start_application_and_show_status",
      target: { kind: "recommendation", ordinal: 1 },
      requiresConfirmation: true
    })).toMatchObject({ kind: "start_application_and_show_status" });

    expect(() => ConversationIntentSchema.parse({
      kind: "run_browser_command",
      tool: "page.evaluate"
    })).toThrow();
  });

  it("rejects unbounded message input", () => {
    expect(() => ConversationTurnInputSchema.parse({ text: "x".repeat(501) })).toThrow();
    expect(() => ConversationTurnInputSchema.parse({ text: "   " })).toThrow();
  });

  it("accepts only known target references", () => {
    expect(ConversationTargetSchema.parse({ kind: "recommendation", ordinal: 1 }))
      .toEqual({ kind: "recommendation", ordinal: 1 });
    expect(() => ConversationTargetSchema.parse({ kind: "recommendation", id: "result-1", url: "https://unsafe" }))
      .toThrow();
  });

  it("keeps cards as a bounded discriminated union", () => {
    expect(ConversationCardSchema.parse({
      type: "recommendation",
      sessionId: "session-1",
      resultId: "result-1",
      title: "Backend Engineer",
      company: "Example Co",
      score: 88,
      evidenceCount: 2
    })).toMatchObject({ type: "recommendation", resultId: "result-1" });

    expect(() => ConversationCardSchema.parse({
      type: "browser_command",
      command: "page.evaluate"
    })).toThrow();
  });

  it("validates persisted messages, context and turn responses strictly", () => {
    const session = ConversationSessionSchema.parse({
      id: "conversation-1",
      title: "Job search",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z"
    });
    const context = ConversationContextSchema.parse({
      version: 0,
      recentPostingIds: ["posting-1"],
      activeJobMatchSessionId: "match-1"
    });
    const message = ConversationMessageSchema.parse({
      id: "message-1",
      sessionId: session.id,
      sequence: 1,
      role: "assistant",
      text: "Here is a recommendation.",
      cards: [],
      createdAt: session.updatedAt
    });
    const response = ConversationTurnResponseSchema.parse({
      message,
      cards: [],
      context
    });

    expect(response.message.id).toBe("message-1");
    expect(response.context.version).toBe(0);
    expect(() => ConversationMessageSchema.parse({ ...message, prompt: "private" })).toThrow();
  });
});
