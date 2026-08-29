import { describe, expect, it, vi } from "vitest";
import { projectLangSmithEvent } from "../agent/langsmith-outbox.js";
import { createConversationGraph, type ConversationGraphDependencies } from "./conversation-graph.js";

describe("conversation observability", () => {
  it("rejects conversation content, prompts, form values, and secrets from LangSmith projection", () => {
    expect(() => projectLangSmithEvent({
      runId: "conversation-1",
      taskId: "conversation-1",
      node: "conversation_classify_intent",
      kind: "model_decision",
      outcome: "accepted",
      reasonCode: "structured_intent",
      input: "投递第一份",
      prompt: "private prompt",
      formValue: "private value",
      apiKey: "secret"
    })).toThrow();
  });

  it("keeps safe projection fields hashed and bounded", () => {
    const event = projectLangSmithEvent({
      runId: "conversation-1",
      taskId: "conversation-1",
      parentRunId: "conversation-root",
      node: "conversation_execute_read",
      kind: "tool_call",
      toolName: "list_recommendations",
      outcome: "completed",
      reasonCode: "read_completed",
      confidence: 0.9,
      durationMs: 12,
      counts: { results: 2, evidence: 4 },
      candidateIds: ["result-1", "result-2"],
      evidenceIds: ["evidence-1"]
    });

    expect(event).toMatchObject({
      parentRunIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      toolName: "list_recommendations",
      candidateCount: 2,
      evidenceCount: 1,
      durationMs: 12
    });
    expect(JSON.stringify(event)).not.toContain("conversation-1");
    expect(JSON.stringify(event)).not.toContain("result-1");
    expect(JSON.stringify(event)).not.toContain("evidence-1");
  });

  it("records a bounded result count for conversation tool calls", async () => {
    const traceRecord = vi.fn(() => "trace-1");
    const dependencies = {
      jobMatchRepository: { get: vi.fn() },
      applicationTasks: {
        list: vi.fn(() => [{
          id: "task-1",
          name: "Frontend Engineer",
          applicationUrl: "https://jobs.example.test/apply/frontend",
          createdAt: "2026-08-22T00:00:00.000Z",
          updatedAt: "2026-08-22T00:00:00.000Z",
          orchestrator: "langgraph-v1" as const,
          profileRevisionApplied: 0,
          profileSyncStatus: "current" as const
        }]),
        get: vi.fn(),
        createFromJob: vi.fn()
      },
      traceSink: { record: traceRecord, list: vi.fn(() => []) }
    } satisfies ConversationGraphDependencies;
    const graph = createConversationGraph(dependencies);

    await graph.invoke({
      conversationId: "conversation-1",
      text: "我投了哪些岗位",
      context: { version: 0, recentPostingIds: [] }
    });

    expect(traceRecord).toHaveBeenCalledWith(expect.objectContaining({
      kind: "tool_call",
      toolName: "list_application_tasks",
      counts: { results: 1 }
    }));
  });
});
