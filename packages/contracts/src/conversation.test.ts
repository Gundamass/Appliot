import { describe, expect, it } from "vitest";
import {
  ConversationCardSchema,
  ConversationConfirmInputSchema,
  ConversationConfirmationSchema,
  ConversationContextSchema,
  ConversationJobMatchActionResultSchema,
  ConversationJobMatchActionSchema,
  ConversationIntentSchema,
  ConversationMessageSchema,
  ConversationProcessEventSchema,
  ConversationProcessHistoryResetSchema,
  ConversationSessionSchema,
  ConversationTargetSchema,
  ConversationTurnInputSchema,
  ConversationTurnResponseSchema,
  ConversationViewSchema
} from "./conversation.js";

describe("conversation contracts", () => {
  it("accepts only guarded inline job-match actions", () => {
    expect(ConversationJobMatchActionSchema.parse({
      conversationId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      action: "select_result",
      sessionVersion: 3,
      idempotencyKey: "select-1",
      resultId: "00000000-0000-4000-8000-000000000003",
      resultVersion: 1,
      postingContentHash: "sha256:posting"
    }).action).toBe("select_result");

    expect(() => ConversationJobMatchActionSchema.parse({
      conversationId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      action: "select_result",
      sessionVersion: 3,
      idempotencyKey: "select-2",
      resultId: "岗位标题"
    })).toThrow();

    expect(() => ConversationJobMatchActionSchema.parse({
      conversationId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      action: "unknown_action",
      sessionVersion: 0,
      idempotencyKey: "x"
    })).toThrow();

    expect(() => ConversationJobMatchActionSchema.parse({
      conversationId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      action: "pause",
      sessionVersion: 0,
      idempotencyKey: "x",
      unexpected: true
    })).toThrow();
  });

  it("requires a conflict hash only for conflict selection", () => {
    expect(() => ConversationJobMatchActionSchema.parse({
      conversationId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      action: "select_conflict_result",
      sessionVersion: 3,
      idempotencyKey: "conflict-1",
      resultId: "00000000-0000-4000-8000-000000000003",
      resultVersion: 1,
      postingContentHash: "sha256:posting"
    })).toThrow();

    const action = ConversationJobMatchActionSchema.parse({
      conversationId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      action: "select_conflict_result",
      sessionVersion: 3,
      idempotencyKey: "conflict-1",
      resultId: "00000000-0000-4000-8000-000000000003",
      resultVersion: 1,
      postingContentHash: "sha256:posting",
      conflictSummaryHash: "sha256:conflicts"
    });
    expect(action.action).toBe("select_conflict_result");
  });

  it("requires an expectation when applying or adjusting filters", () => {
    const expectation = {
      revision: 2,
      confirmedAt: "2026-08-22T00:00:00.000Z",
      criteria: [{ kind: "location", values: ["深圳"], strength: "required" }]
    } as const;
    const base = {
      conversationId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      sessionVersion: 0,
      idempotencyKey: "filters-1"
    };

    expect(ConversationJobMatchActionSchema.parse({ ...base, action: "confirm_filters", expectation }))
      .toMatchObject({ action: "confirm_filters", expectation });
    expect(ConversationJobMatchActionSchema.parse({ ...base, action: "adjust_filters", expectation }).action)
      .toBe("adjust_filters");
    expect(() => ConversationJobMatchActionSchema.parse({ ...base, action: "adjust_filters", expectation: { ...expectation, criteria: [] } })).toThrow();
  });

  it("keeps action results bounded and excludes enterprise recruitment status", () => {
    const result = ConversationJobMatchActionResultSchema.parse({
      sessionId: "session-1",
      state: "awaiting_job_selection",
      version: 4,
      turnSequence: 3,
      message: {
        id: "message-1",
        sessionId: "session-1",
        sequence: 3,
        role: "assistant",
        text: "已完成岗位匹配。",
        cards: [],
        createdAt: "2026-08-22T00:00:00.000Z"
      },
      cards: [],
      context: { version: 1, recentPostingIds: [], activeJobMatchSessionId: "session-1" },
      applicationTaskId: "task-1"
    });
    expect(result.applicationTaskId).toBe("task-1");
    expect(() => ConversationJobMatchActionResultSchema.parse({
      ...result,
      enterpriseRecruitmentStatus: "hired"
    })).toThrow();
  });

  it("accepts only bounded conversation intents", () => {
    expect(ConversationIntentSchema.parse({
      kind: "start_application_and_show_status",
      target: { kind: "recommendation", ordinal: 1 },
      requiresConfirmation: true
    })).toMatchObject({ kind: "start_application_and_show_status" });

    expect(() => ConversationIntentSchema.parse({
      kind: "run_browser_command",
      tool: "page.evaluate"
    })).toThrow();
  });

  it("accepts only HTTPS direct application URL targets", () => {
    expect(ConversationIntentSchema.parse({
      kind: "start_application",
      target: { kind: "application_url", url: "https://jobs.example.com/apply/123" },
      requiresConfirmation: true
    })).toMatchObject({ target: { kind: "application_url" } });

    expect(ConversationConfirmationSchema.parse({
      confirmationId: "confirmation-application-url",
      action: "start_application",
      target: { kind: "application_url", url: "https://jobs.example.com/apply/123" }
    })).toMatchObject({ target: { kind: "application_url" } });

    expect(() => ConversationIntentSchema.parse({
      kind: "start_application",
      target: { kind: "application_url", url: "http://jobs.example.com/apply/123" },
      requiresConfirmation: true
    })).toThrow();
  });

  it("rejects unbounded message input", () => {
    expect(() => ConversationTurnInputSchema.parse({ text: "x".repeat(501) })).toThrow();
    expect(() => ConversationTurnInputSchema.parse({ text: "   " })).toThrow();
  });

  it("accepts only bounded process events", () => {
    expect(ConversationProcessEventSchema.parse({
      id: "7",
      conversationId: "conversation-1",
      turnSequence: 1,
      stepId: "recruitment-search-1",
      type: "process_changed",
      stage: "searching_recruitment_site",
      status: "completed",
      summary: "找到 3 个候选招聘入口",
      tool: {
        name: "tavily_search",
        input: [
          { label: "公司", value: "百度" },
          { label: "招聘类型", value: "校园招聘" }
        ],
        result: "3 个候选，优先域名 talent.baidu.com"
      },
      durationMs: 4820,
      createdAt: "2026-08-22T00:00:00.000Z"
    })).toMatchObject({ stage: "searching_recruitment_site", status: "completed", turnSequence: 1 });

    expect(ConversationProcessEventSchema.parse({
      id: "8",
      conversationId: "conversation-1",
      turnSequence: 1,
      stepId: "wait-recruitment-confirmation",
      type: "process_changed",
      stage: "waiting_for_confirmation",
      status: "waiting",
      summary: "等待你确认招聘入口",
      createdAt: "2026-08-22T00:00:00.000Z"
    })).toMatchObject({ status: "waiting" });

    expect(() => ConversationProcessEventSchema.parse({
      id: "9",
      conversationId: "conversation-1",
      turnSequence: 1,
      stepId: "search-failed",
      type: "process_changed",
      stage: "searching_recruitment_site",
      status: "failed",
      summary: "招聘入口搜索失败",
      failure: {
        code: "TAVILY_TIMEOUT",
        summary: "服务暂时不可用，可以稍后重试",
        retryable: true
      },
      createdAt: "2026-08-22T00:00:00.000Z"
    })).not.toThrow();

    expect(() => ConversationProcessEventSchema.parse({
      id: "10",
      conversationId: "conversation-1",
      turnSequence: 0,
      stepId: "invalid-turn",
      type: "process_changed",
      stage: "searching_recruitment_site",
      status: "running",
      summary: "搜索中",
      createdAt: "2026-08-22T00:00:00.000Z"
    })).toThrow();

    expect(() => ConversationProcessEventSchema.parse({
      id: "11",
      conversationId: "conversation-1",
      turnSequence: 1,
      stepId: "invalid-tool",
      type: "process_changed",
      stage: "searching_recruitment_site",
      status: "completed",
      summary: "搜索完成",
      tool: {
        name: "raw_shell",
        input: [{ label: "命令", value: "private prompt" }]
      },
      createdAt: "2026-08-22T00:00:00.000Z"
    })).toThrow();

    expect(() => ConversationProcessEventSchema.parse({
      id: "12",
      conversationId: "conversation-1",
      turnSequence: 1,
      stepId: "invalid-duration",
      type: "process_changed",
      stage: "searching_recruitment_site",
      status: "completed",
      summary: "搜索完成",
      durationMs: -1,
      createdAt: "2026-08-22T00:00:00.000Z"
    })).toThrow();

    expect(() => ConversationProcessEventSchema.parse({
      id: "8",
      conversationId: "conversation-1",
      type: "process_changed",
      stage: "model_reasoning",
      status: "running",
      message: "private prompt",
      createdAt: "2026-08-22T00:00:00.000Z"
    })).toThrow();

    expect(ConversationProcessHistoryResetSchema.parse({
      type: "history_reset",
      conversationId: "conversation-1",
      reason: "history_gap",
      requestedLastEventId: "1",
      oldestAvailableId: "4"
    })).toMatchObject({ type: "history_reset", oldestAvailableId: "4" });
  });

  it("accepts only known target references", () => {
    expect(ConversationTargetSchema.parse({ kind: "recommendation", ordinal: 1 }))
      .toEqual({ kind: "recommendation", ordinal: 1 });
    expect(() => ConversationTargetSchema.parse({ kind: "recommendation", id: "result-1", url: "https://unsafe" }))
      .toThrow();
  });

  it("accepts bounded recruitment discovery targets and staged confirmations", () => {
    expect(ConversationIntentSchema.parse({
      kind: "discover_recruitment_site",
      target: { kind: "recruitment_site", company: "Baidu", recruitmentType: "campus" }
    })).toMatchObject({
      kind: "discover_recruitment_site",
      target: { company: "Baidu", recruitmentType: "campus" }
    });

    const site = {
      company: "Baidu",
      recruitmentType: "campus" as const,
      query: "Baidu campus recruitment official",
      title: "Baidu Campus Recruitment",
      url: "https://campus.baidu.com/",
      domain: "campus.baidu.com",
      snippet: "校园招聘岗位",
      source: "tavily" as const
    };
    const siteCard = ConversationCardSchema.parse({ type: "recruitment_site", ...site });
    expect(siteCard).toMatchObject({ type: "recruitment_site", url: site.url });

    const sessionCard = ConversationCardSchema.parse({
      type: "job_match_session",
      sessionId: "match-1",
      initialUrl: site.url,
      state: "awaiting_filter_confirmation",
      postingCount: 0
    });
    expect(sessionCard).toMatchObject({ type: "job_match_session", sessionId: "match-1" });

    const confirmation = ConversationConfirmationSchema.parse({
      confirmationId: "confirmation-1",
      action: "request_job_recommendations",
      sourceTurnSequence: 1,
      target: { kind: "recruitment_site", ...site }
    });
    expect(confirmation.action).toBe("request_job_recommendations");

    expect(() => ConversationCardSchema.parse({
      type: "confirmation",
      action: "start_application",
      target: { kind: "recruitment_site", ...site }
    })).toThrow();

    expect(() => ConversationCardSchema.parse({
      type: "confirmation",
      action: "request_job_recommendations",
      target: { kind: "recommendation", sessionId: "match-1", resultId: "result-1" }
    })).toThrow();

    expect(ConversationContextSchema.parse({
      version: 0,
      recentPostingIds: [],
      verifiedRecruitmentSite: site,
      lastRecruitmentRequest: { companyName: "百度", recruitmentType: "campus" }
    })).toMatchObject({ verifiedRecruitmentSite: { company: "Baidu" } });
  });

  it("rejects an arbitrary or non-HTTPS recruitment entry", () => {
    expect(() => ConversationCardSchema.parse({
      type: "recruitment_site",
      company: "Baidu",
      recruitmentType: "campus",
      query: "Baidu campus recruitment official",
      title: "Untrusted result",
      url: "http://example.com/",
      domain: "example.com"
    })).toThrow();
  });

  it("accepts bounded recruitment choices and an HTTPS selected URL", () => {
    const choices = {
      kind: "recruitment_site_choices" as const,
      company: "百度",
      recruitmentType: "campus" as const,
      query: "百度 校园招聘 招聘 官网",
      candidates: [
        {
          title: "百度人才",
          url: "https://talent.baidu.com/",
          domain: "talent.baidu.com",
          snippet: "校园招聘",
          source: "tavily" as const
        },
        {
          title: "百度招聘",
          url: "https://jobs.baidu.com/",
          domain: "jobs.baidu.com",
          snippet: "招聘",
          source: "tavily" as const
        }
      ]
    };

    expect(ConversationConfirmationSchema.parse({
      confirmationId: "confirmation-choices",
      action: "confirm_recruitment_site",
      target: choices
    })).toMatchObject({ target: { candidates: expect.any(Array) } });
    expect(ConversationConfirmInputSchema.parse({
      confirmationId: "confirmation-choices",
      approved: true,
      selectedUrl: "https://talent.baidu.com/"
    })).toMatchObject({ selectedUrl: "https://talent.baidu.com/" });
    expect(() => ConversationConfirmationSchema.parse({
      confirmationId: "confirmation-choices",
      action: "confirm_recruitment_site",
      target: { ...choices, candidates: [] }
    })).toThrow();
    expect(() => ConversationConfirmationSchema.parse({
      confirmationId: "confirmation-choices",
      action: "confirm_recruitment_site",
      target: { ...choices, candidates: [...choices.candidates, choices.candidates[0], choices.candidates[1]] }
    })).toThrow();
    expect(() => ConversationConfirmInputSchema.parse({
      confirmationId: "confirmation-choices",
      approved: true,
      selectedUrl: "http://talent.baidu.com/"
    })).toThrow();
  });

  it("keeps cards as a bounded discriminated union", () => {
    expect(ConversationCardSchema.parse({
      type: "recommendation",
      sessionId: "session-1",
      resultId: "result-1",
      title: "Backend Engineer",
      company: "Example Co",
      score: 88,
      evidenceCount: 2
    })).toMatchObject({ type: "recommendation", resultId: "result-1" });

    expect(() => ConversationCardSchema.parse({
      type: "browser_command",
      command: "page.evaluate"
    })).toThrow();
  });

  it("validates persisted messages, context and turn responses strictly", () => {
    const session = ConversationSessionSchema.parse({
      id: "conversation-1",
      title: "Job search",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z"
    });
    const context = ConversationContextSchema.parse({
      version: 0,
      recentPostingIds: ["posting-1"],
      activeJobMatchSessionId: "match-1"
    });
    const message = ConversationMessageSchema.parse({
      id: "message-1",
      sessionId: session.id,
      sequence: 1,
      role: "assistant",
      text: "Here is a recommendation.",
      cards: [],
      createdAt: session.updatedAt
    });
    const response = ConversationTurnResponseSchema.parse({
      message,
      cards: [],
      context
    });

    expect(response.message.id).toBe("message-1");
    expect(response.context.version).toBe(0);
    expect(() => ConversationMessageSchema.parse({ ...message, prompt: "private" })).toThrow();
  });

  it("preserves the current confirmation in a loaded conversation view", () => {
    const session = ConversationSessionSchema.parse({
      id: "conversation-1",
      title: "Job search",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z"
    });
    const confirmation = ConversationConfirmationSchema.parse({
      confirmationId: "confirmation-1",
      action: "request_job_recommendations",
      target: {
        kind: "recruitment_site",
        company: "Baidu",
        recruitmentType: "campus",
        query: "Baidu campus recruitment official",
        title: "Baidu Campus Recruitment",
        url: "https://campus.baidu.com/",
        domain: "campus.baidu.com",
        snippet: "Campus recruitment roles",
        source: "tavily"
      }
    });
    const view = ConversationViewSchema.parse({
      session,
      messages: [
        {
          id: "message-1",
          sessionId: session.id,
          sequence: 1,
          role: "assistant",
          text: "Recruitment entry confirmed.",
          cards: [{
            type: "confirmation",
            confirmationId: confirmation.confirmationId,
            action: confirmation.action,
            target: confirmation.target
          }],
          createdAt: session.updatedAt
        }
      ],
      context: { version: 1, recentPostingIds: [] },
      pendingConfirmation: confirmation
    });

    expect(view.pendingConfirmation).toEqual(confirmation);
    expect(view.messages[0]?.cards[0]).toMatchObject({ confirmationId: confirmation.confirmationId });
  });
});
