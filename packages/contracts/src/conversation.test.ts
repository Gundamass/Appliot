import { describe, expect, it } from "vitest";
import {
  ConversationCardSchema,
  ConversationConfirmInputSchema,
  ConversationConfirmationSchema,
  ConversationContextSchema,
  ConversationIntentSchema,
  ConversationMessageSchema,
  ConversationSessionSchema,
  ConversationTargetSchema,
  ConversationTurnInputSchema,
  ConversationTurnResponseSchema
} from "./conversation.js";

describe("conversation contracts", () => {
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

  it("rejects unbounded message input", () => {
    expect(() => ConversationTurnInputSchema.parse({ text: "x".repeat(501) })).toThrow();
    expect(() => ConversationTurnInputSchema.parse({ text: "   " })).toThrow();
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
});
