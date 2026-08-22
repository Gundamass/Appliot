import { describe, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type { ConversationContext, ConversationTurnResponse } from "@resume/contracts";
import type { JobMatchAggregate, JobMatchRepository } from "../job-matching/job-match-repository.js";
import { createConversationToolRegistry } from "./conversation-tools.js";
import { createConversationGraph, type ConversationGraphDependencies } from "./conversation-graph.js";

const baseContext: ConversationContext = {
  version: 0,
  activeJobMatchSessionId: "match-1",
  recentPostingIds: ["posting-1"]
};

function fakeDependencies(): ConversationGraphDependencies & {
  createFromJob: ReturnType<typeof vi.fn>;
  startApplication: ReturnType<typeof vi.fn>;
  traceRecord: ReturnType<typeof vi.fn>;
} {
  const createFromJob = vi.fn(() => ({
    id: "task-created",
    name: "Frontend Engineer",
    applicationUrl: "https://jobs.example.test/apply/frontend",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    orchestrator: "langgraph-v1" as const,
    profileRevisionApplied: 0,
    profileSyncStatus: "current" as const
  }));
  const startApplication = vi.fn();
  const traceRecord = vi.fn(() => "trace-1");

  return {
    jobMatchRepository: {
      get: vi.fn((sessionId: string): JobMatchAggregate | undefined => sessionId === "match-1" ? ({
        id: "match-1",
        version: 3,
        state: "awaiting_job_selection",
        initialUrl: "https://jobs.example.test/list",
        scoringVersion: "job-match-v1",
        profileRevision: 0,
        expectationRevision: 0,
        executionEpoch: 0,
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z",
        expectation: {
          revision: 0,
          criteria: [],
          confirmedAt: "2026-08-22T00:00:00.000Z"
        },
        postings: [{
          id: "posting-1",
          source: "moka",
          canonicalUrl: "https://jobs.example.test/apply/frontend",
          title: "Frontend Engineer",
          organization: "Example Labs",
          description: "Build the product UI.",
          requirements: [],
          adapterVersion: "moka-v1",
          contentHash: "hash-1",
          extractedAt: "2026-08-22T00:00:00.000Z"
        }],
        results: [{
          id: "result-1",
          version: 0,
          sessionId: "match-1",
          postingId: "posting-1",
          fitScore: 88,
          confidence: 92,
          rankingScore: 90,
          outcomes: [],
          evidence: [{
            requirementId: "requirement-1",
            evidenceId: "evidence-1",
            source: "confirmed_fact",
            quality: 1,
            summary: "bounded evidence"
          }],
          gaps: [],
          scoringVersion: "job-match-v1",
          profileRevision: 0,
          expectationRevision: 0,
          postingContentHash: "hash-1",
          stale: false
        }],
        events: []
      }) : undefined) as unknown as JobMatchRepository["get"]
    },
    applicationTasks: {
      list: vi.fn(() => [{
        id: "task-1",
        name: "Already applied",
        applicationUrl: "https://jobs.example.test/apply/already",
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
        orchestrator: "langgraph-v1" as const,
        profileRevisionApplied: 0,
        profileSyncStatus: "current" as const
      }]),
      get: vi.fn(),
      createFromJob
    },
    createFromJob,
    applicationService: {
      start: startApplication
    },
    startApplication,
    traceRecord,
    traceSink: {
      record: traceRecord,
      list: vi.fn(() => [])
    }
  };
}

function createRegistryDependencies() {
  const dependencies = fakeDependencies();
  return { dependencies, registry: createConversationToolRegistry(dependencies) };
}

async function runConversationTurn(
  dependencies: ConversationGraphDependencies,
  text: string,
  context: ConversationContext = baseContext
): Promise<ConversationTurnResponse> {
  const graph = createConversationGraph(dependencies);
  const state = await graph.invoke({
    conversationId: "conversation-1",
    text,
    context
  });
  return state.response;
}

describe("conversation graph", () => {
  it("does not expose arbitrary browser operations", async () => {
    const { registry } = createRegistryDependencies();

    expect(registry.names()).toEqual([
      "list_recommendations",
      "show_recommendation",
      "list_application_tasks",
      "show_application_task",
      "create_application_task"
    ]);
    await expect(registry.invoke("page.evaluate" as never, {}, {
      conversationId: "conversation-1",
      recentPostingIds: []
    })).rejects.toThrow("tool_not_allowed");
  });

  it("turns a combined first-application request into a confirmation", async () => {
    const dependencies = fakeDependencies();

    const response = await runConversationTurn(
      dependencies,
      "投递第一份，帮我查看投递进度"
    );

    expect(response.pendingConfirmation?.action).toBe("start_application");
    expect(response.pendingConfirmation?.target.resultId).toBe("result-1");
    expect(response.message.intent?.kind).toBe("start_application_and_show_status");
    expect(dependencies.createFromJob).not.toHaveBeenCalled();
    expect(dependencies.startApplication).not.toHaveBeenCalled();
  });

  it("executes a read-only status query without confirmation", async () => {
    const dependencies = fakeDependencies();

    const response = await runConversationTurn(dependencies, "我投了哪些岗位", {
      version: 0,
      recentPostingIds: []
    });

    expect(response.cards).toHaveLength(1);
    expect(response.cards.every((card) => card.type === "application_task")).toBe(true);
    expect(response.pendingConfirmation).toBeUndefined();
    expect(dependencies.createFromJob).not.toHaveBeenCalled();
  });

  it("falls back to unknown when a structured model returns an invalid intent", async () => {
    const dependencies = fakeDependencies();
    dependencies.modelProvider = {
      generateStructured: vi.fn(async () => ({ kind: "run_browser_command", tool: "page.evaluate" }))
    };

    const response = await runConversationTurn(dependencies, "帮我做点别的事情", {
      version: 0,
      recentPostingIds: []
    });

    expect(response.message.intent?.kind).toBe("unknown");
    expect(response.cards).toEqual([]);
    expect(response.message.text).toContain("目前只能");
  });

  it("keeps the response when tracing fails", async () => {
    const dependencies = fakeDependencies();
    dependencies.traceSink = {
      record: vi.fn(() => {
        throw new Error("trace_sink_unavailable");
      }),
      list: vi.fn(() => [])
    };

    const response = await runConversationTurn(dependencies, "我投了哪些岗位", {
      version: 0,
      recentPostingIds: []
    });

    expect(response.cards[0]).toMatchObject({ type: "application_task", taskId: "task-1" });
  });

  it("records a bounded trace event for each tool call", async () => {
    const dependencies = fakeDependencies();

    await runConversationTurn(dependencies, "我投了哪些岗位", {
      version: 0,
      recentPostingIds: []
    });

    expect(dependencies.traceRecord).toHaveBeenCalledWith(expect.objectContaining({
      kind: "tool_call",
      toolName: "list_application_tasks",
      outcome: "completed",
      durationMs: expect.any(Number)
    }));
  });

  it("uses the configured checkpoint saver for conversation state", async () => {
    const dependencies = fakeDependencies();
    const checkpointer = new MemorySaver();
    const graph = createConversationGraph({ ...dependencies, checkpointer });

    await graph.invoke({
      conversationId: "conversation-1",
      text: "我投了哪些岗位",
      context: { version: 0, recentPostingIds: [] }
    }, { configurable: { thread_id: "conversation-1" } });

    await expect(checkpointer.getTuple({ configurable: { thread_id: "conversation-1" } }))
      .resolves.toBeDefined();
  });
});
