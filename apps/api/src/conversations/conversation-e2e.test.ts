import { describe, expect, it, vi } from "vitest";
import type { ConversationContext, ConversationTurnResponse } from "@resume/contracts";
import type { JobMatchAggregate, JobMatchRepository } from "../job-matching/job-match-repository.js";
import { createConversationGraph, type ConversationGraphDependencies } from "./conversation-graph.js";

const context: ConversationContext = {
  version: 0,
  activeJobMatchSessionId: "match-1",
  recentPostingIds: ["posting-1"]
};

function aggregate(stale = false): JobMatchAggregate {
  return {
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
    expectation: { revision: 0, criteria: [], confirmedAt: "2026-08-22T00:00:00.000Z" },
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
      stale
    }],
    events: []
  } as JobMatchAggregate;
}

function task(id = "task-created") {
  return {
    id,
    name: "Frontend Engineer",
    applicationUrl: "https://jobs.example.test/apply/frontend",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    orchestrator: "langgraph-v1" as const,
    profileRevisionApplied: 0,
    profileSyncStatus: "current" as const
  };
}

function dependencies(options: {
  stale?: boolean;
  startError?: string;
  withJobMatchService?: boolean;
} = {}) {
  const createFromJob = vi.fn(() => task());
  const start = vi.fn(() => {
    if (options.startError !== undefined) throw new Error(options.startError);
  });
  const select = vi.fn();
  const convert = vi.fn(async () => task("converted-task"));
  const get = vi.fn(() => aggregate(options.stale));
  const base = {
    jobMatchRepository: { get } as Pick<JobMatchRepository, "get">,
    applicationTasks: {
      list: vi.fn(() => []),
      get: vi.fn(),
      createFromJob
    },
    applicationService: { start },
    ...(options.withJobMatchService === true ? {
      jobMatchService: {
        select,
        convert
      }
    } : {})
  } satisfies ConversationGraphDependencies;
  return { dependencies: base, createFromJob, start, select, convert, get };
}

async function send(graph: ReturnType<typeof createConversationGraph>, text: string, inputContext = context): Promise<ConversationTurnResponse> {
  return (await graph.invoke({ conversationId: "conversation-e2e", turnSequence: 1, text, context: inputContext })).response;
}

describe("conversation recommendation to application task handoff", () => {
  it("resolves the first recommendation and hands the real result to selection and conversion after approval", async () => {
    const fakes = dependencies({ withJobMatchService: true });
    const graph = createConversationGraph(fakes.dependencies);

    const pending = await send(graph, "投递第一份，帮我查看投递进度");
    expect(pending.pendingConfirmation?.target).toMatchObject({
      kind: "recommendation",
      resultId: "result-1"
    });
    expect(fakes.convert).not.toHaveBeenCalled();

    const confirmed = (await graph.invoke({
      conversationId: "conversation-e2e",
      turnSequence: 2,
      confirmationId: pending.confirmationId,
      approved: true,
      context: pending.context
    })).response;

    expect(fakes.select).toHaveBeenCalledWith("match-1", expect.objectContaining({ resultId: "result-1" }));
    expect(fakes.convert).toHaveBeenCalledWith("match-1", expect.objectContaining({ resultId: "result-1" }));
    expect(confirmed.cards).toMatchObject([{ type: "application_task", taskId: "converted-task" }]);
    expect(confirmed.context.activeApplicationTaskId).toBe("converted-task");
    expect(fakes.createFromJob).not.toHaveBeenCalled();
  });

  it("consumes a confirmation so replay cannot create a second task", async () => {
    const fakes = dependencies();
    const graph = createConversationGraph(fakes.dependencies);
    const pending = await send(graph, "投递第一份");

    await graph.invoke({
      conversationId: "conversation-e2e",
      turnSequence: 2,
      confirmationId: pending.confirmationId,
      approved: true,
      context: pending.context
    });
    const replay = (await graph.invoke({
      conversationId: "conversation-e2e",
      turnSequence: 3,
      confirmationId: pending.confirmationId,
      approved: true,
      context: pending.context
    })).response;

    expect(fakes.createFromJob).toHaveBeenCalledOnce();
    expect(replay.cards).toEqual([]);
    expect(replay.message.text).toContain("失效");
  });

  it("returns bounded recovery text without creating a task for missing context or stale results", async () => {
    const missing = dependencies();
    const missingResponse = await send(
      createConversationGraph(missing.dependencies),
      "投递第一份",
      { version: 0, recentPostingIds: [] }
    );
    expect(missingResponse.message.text).toContain("岗位");
    expect(missing.createFromJob).not.toHaveBeenCalled();

    const stale = dependencies({ stale: true });
    const staleResponse = await send(createConversationGraph(stale.dependencies), "投递第一份");
    expect(staleResponse.message.text).toContain("刷新");
    expect(stale.createFromJob).not.toHaveBeenCalled();
  });

  it("returns a retryable recovery message when the controlled browser worker is unavailable", async () => {
    const fakes = dependencies({ startError: "browser_worker_unavailable" });
    const graph = createConversationGraph(fakes.dependencies);
    const pending = await send(graph, "投递第一份");
    const response = (await graph.invoke({
      conversationId: "conversation-e2e",
      turnSequence: 2,
      confirmationId: pending.confirmationId,
      approved: true,
      context: pending.context
    })).response;

    expect(response.cards).toEqual([]);
    expect(response.message.text).toContain("受控浏览器");
    expect(fakes.createFromJob).toHaveBeenCalledOnce();
  });

  it("explains how to recover from a challenge and a policy lock", async () => {
    const challenge = dependencies({ startError: "challenge_required" });
    const challengeGraph = createConversationGraph(challenge.dependencies);
    const challengePending = await send(challengeGraph, "投递第一份");
    const challengeResponse = (await challengeGraph.invoke({
      conversationId: "conversation-e2e",
      turnSequence: 2,
      confirmationId: challengePending.confirmationId,
      approved: true,
      context: challengePending.context
    })).response;

    const policy = dependencies({ startError: "policy_rejected" });
    const policyGraph = createConversationGraph(policy.dependencies);
    const policyPending = await send(policyGraph, "投递第一份");
    const policyResponse = (await policyGraph.invoke({
      conversationId: "conversation-e2e",
      turnSequence: 2,
      confirmationId: policyPending.confirmationId,
      approved: true,
      context: policyPending.context
    })).response;

    expect(challengeResponse.message.text).toContain("手动接管");
    expect(policyResponse.message.text).toContain("提交已锁定");
  });
});
