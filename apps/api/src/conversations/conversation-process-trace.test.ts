import { describe, expect, it, vi } from "vitest";
import { createConversationProcessTrace } from "./conversation-process-trace.js";

describe("conversation process trace", () => {
  it("records one stable step lifecycle and computes duration", () => {
    const emit = vi.fn();
    const times = [
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-09-01T00:00:01.250Z")
    ];
    const trace = createConversationProcessTrace({
      conversationId: "c1",
      turnSequence: 1,
      emit,
      now: () => times.shift()!
    });

    const step = trace.start({
      stepId: "search-1",
      stage: "searching_recruitment_site",
      summary: "正在搜索百度校园招聘入口"
    });
    step.complete({ summary: "找到 3 个候选招聘入口" });

    expect(emit.mock.calls.map(([event]) => [event.stepId, event.status, event.durationMs])).toEqual([
      ["search-1", "running", undefined],
      ["search-1", "completed", 1250]
    ]);
  });

  it("records waiting and failed terminal states without leaking emitter failures", () => {
    const emit = vi.fn()
      .mockImplementationOnce(() => { throw new Error("event store unavailable"); });
    const trace = createConversationProcessTrace({
      conversationId: "c1",
      turnSequence: 2,
      emit,
      now: () => new Date("2026-09-01T00:00:00.000Z")
    });

    expect(() => trace.start({
      stepId: "wait-1",
      stage: "waiting_for_confirmation",
      summary: "等待你的确认"
    }).wait({ summary: "等待你的确认" })).not.toThrow();

    const failed = trace.start({
      stepId: "search-2",
      stage: "searching_recruitment_site",
      summary: "正在搜索招聘入口"
    });
    failed.fail({
      summary: "服务暂时不可用，可以稍后重试",
      failure: { code: "TAVILY_TIMEOUT", summary: "服务暂时不可用，可以稍后重试", retryable: true }
    });

    expect(emit).toHaveBeenCalledTimes(4);
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ status: "failed", failure: { code: "TAVILY_TIMEOUT" } });
  });
});
