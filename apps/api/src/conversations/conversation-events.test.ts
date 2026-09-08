import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createConversationProcessEventBus, type ConversationProcessEventInput } from "./conversation-events.js";
import { createConversationRepository } from "./conversation-repository.js";

describe("conversation process event bus", () => {
  it("clears one in-memory conversation without affecting another", () => {
    const bus = createConversationProcessEventBus();
    bus.emit(eventInput("conversation-a"));
    bus.emit(eventInput("conversation-b"));

    bus.clearConversation("conversation-a");

    expect(bus.replay("conversation-a").events).toEqual([]);
    expect(bus.replay("conversation-b").events).toHaveLength(1);

    bus.clearAll();

    expect(bus.replay("conversation-b").events).toEqual([]);
  });

  it("clears SQLite events and replay cursors for one conversation", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const conversation = createConversationRepository(database).createConversation();
    const bus = createConversationProcessEventBus(database, { historyLimit: 1 });
    bus.emit(eventInput(conversation.id, { stepId: "step-1" }));
    bus.emit(eventInput(conversation.id, { stepId: "step-2" }));

    expect(database.prepare("SELECT * FROM conversation_process_event_cursors WHERE conversation_id = ?")
      .get(conversation.id)).toBeDefined();

    bus.clearConversation(conversation.id);

    expect(database.prepare("SELECT * FROM conversation_process_events WHERE conversation_id = ?")
      .all(conversation.id)).toEqual([]);
    expect(database.prepare("SELECT * FROM conversation_process_event_cursors WHERE conversation_id = ?")
      .all(conversation.id)).toEqual([]);
    database.close();
  });

  it("persists process events and replays them after the bus is recreated", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const conversation = createConversationRepository(database).createConversation();
    const first = createConversationProcessEventBus(database);
    const one = first.emit(eventInput(conversation.id, {
      stepId: "understand-request",
      stage: "understanding_request",
      status: "running",
      summary: "正在理解你的请求"
    }));
    const two = first.emit(eventInput(conversation.id, {
      stepId: "generate-response",
      stage: "generating_response",
      status: "completed",
      summary: "回复已生成",
      durationMs: 1250,
      tool: {
        name: "job_matching",
        input: [{ label: "操作", value: "读取岗位推荐" }],
        result: "返回 2 条记录"
      }
    }));

    const reopened = createConversationProcessEventBus(database);

    expect(Number(two.id)).toBeGreaterThan(Number(one.id));
    expect(reopened.replay(conversation.id, one.id).events).toEqual([two]);
    database.close();
  });

  it("publishes future events and removes subscribers", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const conversation = createConversationRepository(database).createConversation();
    const bus = createConversationProcessEventBus(database);
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(conversation.id, listener);

    const event = bus.emit(eventInput(conversation.id, {
      stepId: "search-1",
      stage: "searching_recruitment_site",
      status: "running",
      summary: "正在搜索官方招聘入口"
    }));
    expect(listener).toHaveBeenCalledWith(event);
    expect(bus.subscriberCount(conversation.id)).toBe(1);

    unsubscribe();
    expect(bus.subscriberCount(conversation.id)).toBe(0);
    database.close();
  });

  it("returns a reset signal when the requested process history was truncated", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const conversation = createConversationRepository(database).createConversation();
    const bus = createConversationProcessEventBus(database, { historyLimit: 2 });
    const discarded = bus.emit(eventInput(conversation.id, {
      stepId: "understand-request",
      stage: "understanding_request",
      status: "running",
      summary: "正在理解你的请求"
    }));
    const second = bus.emit(eventInput(conversation.id, {
      stepId: "search-1",
      stage: "searching_recruitment_site",
      status: "running",
      summary: "正在搜索官方招聘入口"
    }));
    const third = bus.emit(eventInput(conversation.id, {
      stepId: "site-found-1",
      stage: "recruitment_site_found",
      status: "completed",
      summary: "已找到招聘入口"
    }));

    expect(bus.replay(conversation.id, discarded.id)).toEqual({
      events: [second, third],
      reset: {
        type: "history_reset",
        conversationId: conversation.id,
        reason: "history_gap",
        requestedLastEventId: discarded.id,
        oldestAvailableId: second.id
      }
    });
    database.close();
  });
});

function eventInput(
  conversationId: string,
  overrides: Partial<ConversationProcessEventInput> = {}
): ConversationProcessEventInput {
  return {
    conversationId,
    turnSequence: 1,
    stepId: "step-1",
    stage: "completed",
    status: "completed",
    summary: "处理完成",
    ...overrides
  };
}
