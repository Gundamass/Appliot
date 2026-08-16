import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectTaskEvents, useTaskEvents, type TaskEventConnection, type TaskEventHandlers } from "./useTaskEvents.js";

class FakeEventSource extends EventTarget {
  static latest: FakeEventSource;
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeEventSource.latest = this;
  }
  close() { this.closed = true; }
}

afterEach(() => vi.unstubAllGlobals());

describe("connectTaskEvents", () => {
  it("parses state and history-reset events and keeps native reconnect signals visible", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const handlers = { onOpen: vi.fn(), onEvent: vi.fn(), onHistoryReset: vi.fn(), onDisconnect: vi.fn() };
    const disconnect = connectTaskEvents("0f8fad5b-d9cb-469f-a165-70867728950e", handlers);
    const source = FakeEventSource.latest;

    source.dispatchEvent(new Event("open"));
    source.dispatchEvent(new MessageEvent("state_changed", { data: JSON.stringify({
      id: "2", taskId: "0f8fad5b-d9cb-469f-a165-70867728950e", type: "state_changed",
      state: "observing_page", createdAt: "2026-07-28T08:00:00.000Z"
    }) }));
    source.dispatchEvent(new MessageEvent("history_reset", { data: JSON.stringify({
      type: "history_reset", taskId: "0f8fad5b-d9cb-469f-a165-70867728950e", reason: "history_gap",
      requestedLastEventId: "1", oldestAvailableId: "8"
    }) }));
    source.dispatchEvent(new Event("error"));
    disconnect();

    expect(source.url).toContain("/api/applications/0f8fad5b-d9cb-469f-a165-70867728950e/events");
    expect(handlers.onOpen).toHaveBeenCalledOnce();
    expect(handlers.onEvent).toHaveBeenCalledWith(expect.objectContaining({ id: "2", state: "observing_page" }));
    expect(handlers.onHistoryReset).toHaveBeenCalledWith(expect.objectContaining({ reason: "history_gap" }));
    expect(handlers.onDisconnect).toHaveBeenCalledOnce();
    expect(source.closed).toBe(true);
  });

  it("strictly parses replayable progress and redacted activity events", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const handlers = { onOpen: vi.fn(), onEvent: vi.fn(), onHistoryReset: vi.fn(), onDisconnect: vi.fn() };
    connectTaskEvents("0f8fad5b-d9cb-469f-a165-70867728950e", handlers);
    const source = FakeEventSource.latest;
    const progress = {
      id: "3", taskId: "0f8fad5b-d9cb-469f-a165-70867728950e", type: "operation_started",
      createdAt: "2026-07-28T08:00:00.000Z",
      progress: { current: 5, total: 8, phase: "filling", fieldId: "opaque-5", displayCategory: "联系方式" },
      operation: { kind: "fill", status: "running", elapsedMs: 1200, timeoutMs: 15000 }
    };

    source.dispatchEvent(new MessageEvent("operation_started", { data: JSON.stringify(progress) }));
    source.dispatchEvent(new MessageEvent("browser_activity", { data: JSON.stringify({
      id: "4", taskId: progress.taskId, type: "browser_activity", createdAt: progress.createdAt,
      activity: { kind: "page_stable", displayCategory: "页面状态" }
    }) }));
    source.dispatchEvent(new MessageEvent("operation_started", { data: JSON.stringify({ ...progress, value: "secret" }) }));

    source.dispatchEvent(new MessageEvent("execution_progress_changed", { data: JSON.stringify({
      id: "5", taskId: progress.taskId, type: "execution_progress_changed", createdAt: progress.createdAt,
      executionProgress: {
        currentPhase: "semantic_fill",
        phases: [
          { phase: "waiting_for_form", status: "completed" },
          { phase: "deterministic_fill", status: "completed" },
          { phase: "semantic_fill", status: "running" },
          { phase: "readback_validation", status: "pending" },
          { phase: "final_review", status: "pending" }
        ],
        current: { action: "正在选择：本科专业", fieldId: "major", attempt: 1, maxAttempts: 2 },
        counts: { exact: 12, semantic: 3, user: 4, missing: 2, failed: 1 }
      }
    }) }));

    expect(handlers.onEvent).toHaveBeenCalledTimes(3);
    expect(handlers.onEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "operation_started" }));
    expect(handlers.onEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: "browser_activity" }));
    expect(handlers.onEvent).toHaveBeenNthCalledWith(3, expect.objectContaining({ type: "execution_progress_changed" }));
  });

  it("returns to connecting while a new task subscription opens", () => {
    const opens = new Map<string, () => void>();
    const connect: TaskEventConnection = (taskId, handlers) => {
      opens.set(taskId, handlers.onOpen);
      return () => undefined;
    };
    const handlers = { onEvent: vi.fn(), onHistoryReset: vi.fn() };
    function Probe({ taskId }: { taskId: string }) {
      const status = useTaskEvents(taskId, handlers, connect);
      return createElement("span", undefined, status);
    }
    const { rerender } = render(createElement(Probe, { taskId: "task-a" }));
    act(() => opens.get("task-a")?.());
    expect(screen.getByText("connected")).toBeVisible();

    rerender(createElement(Probe, { taskId: "task-b" }));

    expect(screen.getByText("connecting")).toBeVisible();
  });

  it("ignores stale connection callbacks after switching tasks", () => {
    const subscriptions = new Map<string, TaskEventHandlers>();
    const connect: TaskEventConnection = (taskId, handlers) => {
      subscriptions.set(taskId, handlers);
      return () => undefined;
    };
    const handlers = { onEvent: vi.fn(), onHistoryReset: vi.fn() };
    function Probe({ taskId }: { taskId: string }) {
      const status = useTaskEvents(taskId, handlers, connect);
      return createElement("span", undefined, status);
    }
    const { rerender } = render(createElement(Probe, { taskId: "task-a" }));
    const stale = subscriptions.get("task-a")!;

    rerender(createElement(Probe, { taskId: "task-b" }));
    act(() => subscriptions.get("task-b")?.onOpen());
    expect(screen.getByText("connected")).toBeVisible();

    act(() => stale.onDisconnect());
    expect(screen.getByText("connected")).toBeVisible();
  });
});
