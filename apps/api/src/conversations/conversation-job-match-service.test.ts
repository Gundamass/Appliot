import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationJobMatchAction,
  ConversationProcessEvent,
  JobExpectationSnapshot,
  JobMatchResult
} from "@resume/contracts";
import { ConversationMessageSchema } from "@resume/contracts";
import type { JobMatchAggregate, StoredJobMatchSession } from "../job-matching/job-match-repository.js";
import type { createJobMatchService } from "../job-matching/job-match-service.js";
import { migrateDatabase } from "../db/migrate.js";
import { createConversationRepository } from "./conversation-repository.js";
import { createConversationProcessEventBus } from "./conversation-events.js";
import { createConversationJobMatchService } from "./conversation-job-match-service.js";

const databases: Database.Database[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

const expectation: JobExpectationSnapshot = {
  revision: 3,
  confirmedAt: "2026-09-02T00:00:00.000Z",
  criteria: [{ kind: "target_role", values: ["前端工程师"], strength: "required" }]
};

function posting() {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    source: "baidu" as const,
    sourceJobId: "baidu-job-1",
    canonicalUrl: "https://talent.baidu.com/job/frontend",
    title: "前端工程师",
    organization: "百度",
    location: "北京",
    employmentType: "校招",
    description: "负责产品前端开发。",
    requirements: [],
    adapterVersion: "baidu-job-v1",
    contentHash: "sha256:posting-1",
    extractedAt: "2026-09-02T00:00:00.000Z"
  };
}

function result(sessionId: string): JobMatchResult {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    version: 2,
    sessionId,
    postingId: posting().id,
    fitScore: 91,
    confidence: 88,
    rankingScore: 90,
    outcomes: [],
    evidence: [{
      requirementId: "requirement-1",
      evidenceId: "evidence-1",
      source: "confirmed_fact",
      quality: 0.95,
      summary: "已确认的前端项目经历"
    }],
    gaps: [],
    scoringVersion: "job-match-v1",
    profileRevision: 4,
    expectationRevision: expectation.revision,
    postingContentHash: posting().contentHash,
    stale: false
  };
}

function aggregate(sessionId: string): JobMatchAggregate {
  const createdAt = "2026-09-02T00:00:00.000Z";
  return {
    id: sessionId,
    version: 3,
    state: "extracting_jobs",
    initialUrl: "https://talent.baidu.com/jobs/list",
    scoringVersion: "job-match-v1",
    profileRevision: 4,
    expectationRevision: expectation.revision,
    executionEpoch: 1,
    createdAt,
    updatedAt: createdAt,
    expectation,
    postings: [posting()],
    results: [result(sessionId)],
    events: []
  };
}

function testContext() {
  const database = new Database(":memory:");
  databases.push(database);
  migrateDatabase(database);
  const conversations = createConversationRepository(database);
  const conversation = conversations.createConversation();
  const otherConversation = conversations.createConversation();
  const processEvents = createConversationProcessEventBus(database);
  const sessionId = "33333333-3333-4333-8333-333333333333";
  database.prepare(`
    INSERT INTO job_match_sessions (
      id, version, state, initial_url, scoring_version, profile_revision,
      expectation_revision, execution_epoch, created_at, updated_at
    ) VALUES (?, 0, 'extracting_jobs', ?, 'job-match-v1', ?, ?, 1, ?, ?)
  `).run(
    sessionId,
    "https://talent.baidu.com/jobs/list",
    expectation.revision,
    expectation.revision,
    "2026-09-02T00:00:00.000Z",
    "2026-09-02T00:00:00.000Z"
  );
  conversations.linkJobMatchSession(conversation.id, sessionId);

  let current = aggregate(sessionId);
  const continueExtraction = vi.fn(async () => current);
  const jobMatches = {
    get: vi.fn(() => current),
    confirmFilters: vi.fn(async () => current),
    pause: vi.fn(async () => current),
    resume: vi.fn(async () => current),
    continueExtraction,
    rematch: vi.fn(async () => current),
    select: vi.fn((): StoredJobMatchSession => current),
    selectConflict: vi.fn((): StoredJobMatchSession => current),
    convert: vi.fn(),
    cancel: vi.fn()
  } as unknown as ReturnType<typeof createJobMatchService>;
  const service = createConversationJobMatchService({
    conversations,
    jobMatches,
    processEvents,
    now: () => new Date("2026-09-02T00:00:01.000Z")
  });

  return {
    conversations,
    conversation,
    otherConversation,
    sessionId,
    resultId: current.results[0]!.id,
    postingContentHash: current.postings[0]!.contentHash,
    expectation,
    processEvents,
    jobMatches,
    continueExtraction,
    service,
    setCurrent(next: JobMatchAggregate) { current = next; }
  };
}

function selectAction(value: ReturnType<typeof testContext>): ConversationJobMatchAction {
  return {
    conversationId: value.conversation.id,
    sessionId: value.sessionId,
    action: "select_result",
    sessionVersion: 3,
    idempotencyKey: "select-trace-1",
    resultId: value.resultId,
    resultVersion: 2,
    postingContentHash: value.postingContentHash
  };
}

function continueAction(value: ReturnType<typeof testContext>): ConversationJobMatchAction {
  return {
    conversationId: value.conversation.id,
    sessionId: value.sessionId,
    action: "continue",
    sessionVersion: 3,
    idempotencyKey: "continue-trace-1"
  };
}

function pauseAction(
  value: ReturnType<typeof testContext>,
  overrides: { conversationId?: string; sessionVersion?: number; idempotencyKey?: string } = {}
) {
  return {
    conversationId: value.conversation.id,
    sessionId: value.sessionId,
    action: "pause" as const,
    sessionVersion: 3,
    idempotencyKey: "pause-1",
    ...overrides
  };
}

describe("conversation job-match action service", () => {
  it("dispatches confirm_filters only to the linked session", async () => {
    const value = testContext();
    const action = {
      conversationId: value.conversation.id,
      sessionId: value.sessionId,
      action: "confirm_filters" as const,
      sessionVersion: 3,
      idempotencyKey: "confirm-filters-1",
      expectation: value.expectation
    };

    await value.service.execute(value.conversation.id, action);

    expect(value.jobMatches.confirmFilters).toHaveBeenCalledWith(value.sessionId, value.expectation, {
      sessionVersion: 3,
      idempotencyKey: "confirm-filters-1"
    });
  });

  it("dispatches each inline action with real guarded identifiers", async () => {
    const value = testContext();
    const guard = { sessionVersion: 3, idempotencyKey: "operation-1" };
    await value.service.execute(value.conversation.id, {
      ...guard,
      conversationId: value.conversation.id,
      sessionId: value.sessionId,
      action: "adjust_filters",
      expectation: value.expectation
    });
    await value.service.execute(value.conversation.id, {
      ...guard,
      conversationId: value.conversation.id,
      sessionId: value.sessionId,
      action: "continue",
      idempotencyKey: "operation-2"
    });
    await value.service.execute(value.conversation.id, {
      ...guard,
      conversationId: value.conversation.id,
      sessionId: value.sessionId,
      action: "rematch",
      idempotencyKey: "operation-3"
    });
    await value.service.execute(value.conversation.id, {
      ...guard,
      conversationId: value.conversation.id,
      sessionId: value.sessionId,
      action: "select_result",
      idempotencyKey: "operation-4",
      resultId: value.resultId,
      resultVersion: 2,
      postingContentHash: value.postingContentHash
    });
    await value.service.execute(value.conversation.id, {
      ...guard,
      conversationId: value.conversation.id,
      sessionId: value.sessionId,
      action: "select_conflict_result",
      idempotencyKey: "operation-5",
      resultId: value.resultId,
      resultVersion: 2,
      postingContentHash: value.postingContentHash,
      conflictSummaryHash: "sha256:conflicts"
    });

    expect(value.jobMatches.confirmFilters).toHaveBeenCalledWith(value.sessionId, value.expectation, guard);
    expect(value.jobMatches.continueExtraction).toHaveBeenCalledWith(value.sessionId, {
      sessionVersion: 3,
      idempotencyKey: "operation-2"
    });
    expect(value.jobMatches.rematch).toHaveBeenCalledWith(value.sessionId, {
      sessionVersion: 3,
      idempotencyKey: "operation-3"
    });
    expect(value.jobMatches.select).toHaveBeenCalledWith(value.sessionId, {
      sessionVersion: 3,
      idempotencyKey: "operation-4",
      resultId: value.resultId,
      resultVersion: 2,
      postingContentHash: value.postingContentHash
    });
    expect(value.jobMatches.selectConflict).toHaveBeenCalledWith(value.sessionId, {
      sessionVersion: 3,
      idempotencyKey: "operation-5",
      resultId: value.resultId,
      resultVersion: 2,
      postingContentHash: value.postingContentHash,
      conflictSummaryHash: "sha256:conflicts"
    });
  });

  it("persists a user turn and returns bounded session and recommendation cards", async () => {
    const value = testContext();
    const response = await value.service.execute(value.conversation.id, pauseAction(value));
    const messages = value.conversations.listMessages(value.conversation.id);

    expect(response).toMatchObject({
      sessionId: value.sessionId,
      state: "extracting_jobs",
      version: 3,
      turnSequence: 1,
      context: { version: 1, activeJobMatchSessionId: value.sessionId }
    });
    expect(response.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "job_match_session", sessionId: value.sessionId }),
      expect.objectContaining({ type: "recommendation", resultId: value.resultId, title: "前端工程师" })
    ]));
    expect(messages.map((message) => [message.role, message.sequence])).toEqual([
      ["user", 1],
      ["assistant", 2]
    ]);
    expect(messages[1]!.cards).toEqual(response.cards);
  });

  it("rejects a session linked to another conversation before invoking the domain action", async () => {
    const value = testContext();
    const action = pauseAction(value, { conversationId: value.otherConversation.id });

    await expect(value.service.execute(value.otherConversation.id, action))
      .rejects.toThrow("conversation_job_match_not_owned");
    expect(value.jobMatches.pause).not.toHaveBeenCalled();
  });

  it("replays the same idempotency key and rejects a changed payload", async () => {
    const value = testContext();
    const action = pauseAction(value);
    const first = await value.service.execute(value.conversation.id, action);
    const replay = await value.service.execute(value.conversation.id, action);

    expect(replay).toEqual(first);
    expect(value.jobMatches.pause).toHaveBeenCalledOnce();
    await expect(value.service.execute(value.conversation.id, { ...action, sessionVersion: 9 }))
      .rejects.toThrow("conversation_idempotency_conflict");
  });

  it("finds the owning conversation without exposing the job-match aggregate", async () => {
    const value = testContext();

    await expect(value.service.findOwningConversation(value.sessionId)).resolves.toEqual({
      conversationId: value.conversation.id
    });
    await expect(value.service.findOwningConversation("66666666-6666-4666-8666-666666666666"))
      .resolves.toBeUndefined();
  });

  it("records a job action under one user turn with ordered real stages", async () => {
    const value = testContext();
    for (const [sequence, role] of [[1, "user"], [2, "assistant"]] as const) {
      value.conversations.appendMessage({
        sessionId: value.conversation.id,
        expectedSequence: sequence - 1,
        message: ConversationMessageSchema.parse({
          id: `history-${sequence}`,
          sessionId: value.conversation.id,
          sequence,
          role,
          text: "历史消息",
          cards: [],
          createdAt: "2026-09-02T00:00:00.000Z"
        })
      });
    }

    const result = await value.service.execute(value.conversation.id, selectAction(value));
    const events: ConversationProcessEvent[] = value.processEvents.replay(value.conversation.id).events;

    expect(events.map((event) => [event.turnSequence, event.stepId, event.status])).toEqual([
      [3, "understanding-request", "running"],
      [3, "understanding-request", "completed"],
      [3, "validate-selection", "running"],
      [3, "validate-selection", "completed"],
      [3, "persist-selection", "running"],
      [3, "persist-selection", "completed"]
    ]);
    expect(result.turnSequence).toBe(3);
    expect(result.cards.some((card) => card.type === "recommendation")).toBe(true);
  });

  it("uses waiting for login or challenge and never exposes raw tool data", async () => {
    const value = testContext();
    value.continueExtraction.mockRejectedValueOnce(
      new Error("browser_challenge_required cookie=secret browser_worker=raw")
    );

    await expect(value.service.execute(value.conversation.id, continueAction(value))).rejects.toThrow();

    const event = value.processEvents.replay(value.conversation.id).events.at(-1);
    expect(event).toMatchObject({ status: "waiting" });
    expect(JSON.stringify(event)).not.toContain("cookie=secret");
    expect(JSON.stringify(event)).not.toContain("browser_worker");
  });
});
