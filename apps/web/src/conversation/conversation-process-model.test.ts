import type { ConversationProcessEvent } from "@resume/contracts";
import { describe, expect, it } from "vitest";
import { groupConversationProcessEvents } from "./conversation-process-model.js";

function event(overrides: Partial<ConversationProcessEvent> = {}): ConversationProcessEvent {
  return {
    id: "1",
    conversationId: "conversation-1",
    turnSequence: 1,
    stepId: "search-1",
    type: "process_changed",
    stage: "searching_recruitment_site",
    status: "running",
    summary: "正在搜索官方招聘入口",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

describe("groupConversationProcessEvents", () => {
  it("keeps turns separate and reduces updates by step id", () => {
    const grouped = groupConversationProcessEvents([
      event({ id: "1", turnSequence: 1, stepId: "search-1", status: "running" }),
      event({ id: "2", turnSequence: 1, stepId: "search-1", status: "completed", summary: "找到 3 个招聘入口", durationMs: 1200 }),
      event({ id: "3", turnSequence: 3, stepId: "search-1", status: "running" }),
      event({ id: "4", turnSequence: 3, stepId: "search-2", status: "running", stage: "loading_application_progress", summary: "正在查询投递进度" })
    ]);

    expect(grouped.get(1)?.steps).toHaveLength(1);
    expect(grouped.get(1)?.steps[0]?.status).toBe("completed");
    expect(grouped.get(3)?.steps.map(({ stepId }) => stepId)).toEqual(["search-1", "search-2"]);
  });

  it("ignores duplicate ids and keeps the latest event for an out-of-order step", () => {
    const grouped = groupConversationProcessEvents([
      event({ id: "5", stepId: "search-1", status: "completed", summary: "搜索完成", durationMs: 800 }),
      event({ id: "3", stepId: "search-1", status: "running" }),
      event({ id: "5", stepId: "search-1", status: "failed", summary: "不应覆盖已接收事件", failure: { code: "NO_SAFE_CANDIDATE", summary: "不应覆盖已接收事件", retryable: true } }),
      event({ id: "6", stepId: "search-2", status: "failed", summary: "招聘入口不可用", failure: { code: "TAVILY_UNAVAILABLE", summary: "招聘入口不可用", retryable: true } })
    ]);

    expect(grouped.get(1)?.steps.map(({ status }) => status)).toEqual(["completed", "failed"]);
    expect(grouped.get(1)?.steps[0]?.summary).toBe("搜索完成");
    expect(grouped.get(1)?.failed).toBe(true);
    expect(grouped.get(1)?.active).toBe(false);
    expect(grouped.get(1)?.totalDurationMs).toBe(800);
  });

  it("marks waiting and running steps active and sums known durations", () => {
    const grouped = groupConversationProcessEvents([
      event({ id: "10", stepId: "understand", stage: "understanding_request", status: "completed", durationMs: 250 }),
      event({ id: "11", stepId: "wait", stage: "waiting_for_confirmation", status: "waiting", summary: "等待你的确认" }),
      event({ id: "12", stepId: "response", stage: "generating_response", status: "running", summary: "正在生成回复", durationMs: 40 })
    ]);

    expect(grouped.get(1)).toMatchObject({ active: true, failed: false, totalDurationMs: 290 });
  });
});
