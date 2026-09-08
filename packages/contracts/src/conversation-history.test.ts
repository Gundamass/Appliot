import { describe, expect, it } from "vitest";
import {
  ConversationHistoryClearResultSchema,
  ConversationSessionListSchema
} from "./conversation.js";

const session = {
  id: "conversation-1",
  title: "新会话",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z"
};

describe("conversation history contracts", () => {
  it("accepts a bounded conversation summary list", () => {
    expect(ConversationSessionListSchema.parse([session])).toEqual([session]);
    expect(() => ConversationSessionListSchema.parse([{ ...session, extra: true }])).toThrow();
  });

  it("accepts only a non-negative integer clear count", () => {
    expect(ConversationHistoryClearResultSchema.parse({ deletedCount: 2 })).toEqual({ deletedCount: 2 });
    expect(() => ConversationHistoryClearResultSchema.parse({ deletedCount: -1 })).toThrow();
    expect(() => ConversationHistoryClearResultSchema.parse({ deletedCount: 1, extra: true })).toThrow();
  });
});
