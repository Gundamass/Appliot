import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectConversationProcessEvents,
  useConversationProcessEvents,
  type ConversationProcessEventConnection,
  type ConversationProcessEventHandlers
} from "./conversation-process-events.js";

class FakeEventSource extends EventTarget {
  static latest: FakeEventSource;
  closed = false;

  constructor(readonly url: string) {
    super();
    FakeEventSource.latest = this;
  }

  close(): void {
    this.closed = true;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("connectConversationProcessEvents", () => {
  it("reports an unavailable EventSource as disconnected without throwing", () => {
    vi.stubGlobal("EventSource", undefined);
    const handlers = {
      onOpen: vi.fn(),
      onEvent: vi.fn(),
      onHistoryReset: vi.fn(),
      onDisconnect: vi.fn()
    } satisfies ConversationProcessEventHandlers;

    expect(() => connectConversationProcessEvents("conversation-1", handlers)).not.toThrow();
    expect(handlers.onDisconnect).toHaveBeenCalledOnce();
  });

  it("parses bounded process and history-reset events and closes the source", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const handlers = {
      onOpen: vi.fn(),
      onEvent: vi.fn(),
      onHistoryReset: vi.fn(),
      onDisconnect: vi.fn()
    } satisfies ConversationProcessEventHandlers;
    const disconnect = connectConversationProcessEvents("conversation-1", handlers);
    const source = FakeEventSource.latest;

    source.dispatchEvent(new Event("open"));
    source.dispatchEvent(new MessageEvent("process_changed", { data: JSON.stringify({
      id: "2",
      conversationId: "conversation-1",
      type: "process_changed",
      turnSequence: 1,
      stepId: "search-1",
      stage: "searching_recruitment_site",
      status: "running",
      summary: "正在搜索官方招聘入口",
      createdAt: "2026-08-22T00:00:00.000Z"
    }) }));
    source.dispatchEvent(new MessageEvent("history_reset", { data: JSON.stringify({
      type: "history_reset",
      conversationId: "conversation-1",
      reason: "history_gap",
      requestedLastEventId: "1",
      oldestAvailableId: "8"
    }) }));
    source.dispatchEvent(new MessageEvent("process_changed", { data: JSON.stringify({
      id: "3",
      conversationId: "conversation-1",
      type: "process_changed",
      turnSequence: 1,
      stepId: "search-2",
      stage: "searching_recruitment_site",
      status: "running",
      summary: "正在搜索官方招聘入口",
      headers: { authorization: "Bearer hidden" },
      createdAt: "2026-08-22T00:00:00.000Z"
    }) }));
    source.dispatchEvent(new Event("error"));
    disconnect();

    expect(source.url).toContain("/api/conversations/conversation-1/events");
    expect(handlers.onOpen).toHaveBeenCalledOnce();
    expect(handlers.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      id: "2",
      stage: "searching_recruitment_site"
    }));
    expect(handlers.onEvent).toHaveBeenCalledOnce();
    expect(handlers.onHistoryReset).toHaveBeenCalledWith(expect.objectContaining({ reason: "history_gap" }));
    expect(handlers.onDisconnect).toHaveBeenCalledOnce();
    expect(source.closed).toBe(true);
  });

  it("returns to connecting for a new conversation and ignores stale callbacks", () => {
    const subscriptions = new Map<string, ConversationProcessEventHandlers>();
    const connect: ConversationProcessEventConnection = (conversationId, handlers) => {
      subscriptions.set(conversationId, handlers);
      return () => undefined;
    };
    const handlers = { onEvent: vi.fn(), onHistoryReset: vi.fn() };
    function Probe({ conversationId }: { conversationId?: string }) {
      const status = useConversationProcessEvents(conversationId, handlers, connect);
      return createElement("span", undefined, status);
    }

    const { rerender } = render(createElement(Probe, { conversationId: "conversation-a" }));
    act(() => subscriptions.get("conversation-a")?.onOpen());
    expect(screen.getByText("connected")).toBeVisible();

    rerender(createElement(Probe, { conversationId: "conversation-b" }));
    expect(screen.getByText("connecting")).toBeVisible();
    act(() => subscriptions.get("conversation-a")?.onDisconnect());
    expect(screen.getByText("connecting")).toBeVisible();
  });
});
