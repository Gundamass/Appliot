import { describe, expect, it, vi } from "vitest";
import type { RecruitmentSiteSearchResult, VerifiedRecruitmentSite } from "@resume/contracts";
import type { JobMatchAggregate, JobMatchRepository } from "../job-matching/job-match-repository.js";
import {
  createConversationToolRegistry,
  type ConversationToolDependencies
} from "./conversation-tools.js";

const site: VerifiedRecruitmentSite = {
  company: "Baidu",
  recruitmentType: "campus",
  query: "Baidu campus recruitment official",
  title: "Baidu Campus Recruitment",
  url: "https://campus.baidu.com/",
  domain: "campus.baidu.com",
  snippet: "Campus recruitment roles",
  source: "tavily"
};

function aggregate(): JobMatchAggregate {
  return {
    id: "match-1",
    version: 1,
    state: "awaiting_filter_confirmation",
    initialUrl: site.url,
    scoringVersion: "job-match-v1",
    profileRevision: 0,
    expectationRevision: 0,
    executionEpoch: 0,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    expectation: { revision: 0, criteria: [], confirmedAt: "2026-08-24T00:00:00.000Z" },
    postings: [],
    results: [],
    events: []
  } as JobMatchAggregate;
}

function dependencies(overrides: Partial<ConversationToolDependencies> = {}): ConversationToolDependencies {
  return {
    jobMatchRepository: { get: vi.fn(() => aggregate()) } as Pick<JobMatchRepository, "get">,
    applicationTasks: {
      list: vi.fn(() => []),
      get: vi.fn(),
      createFromJob: vi.fn()
    },
    ...overrides
  };
}

const context = {
  conversationId: "conversation-1",
  recentPostingIds: []
};

describe("conversation recruitment tools", () => {
  it("returns bounded search candidates without creating or releasing a browser owner", async () => {
    const searchResult: RecruitmentSiteSearchResult = {
      query: "Baidu campus recruitment official",
      candidates: [{
        title: site.title,
        url: site.url,
        domain: site.domain,
        snippet: site.snippet,
        source: site.source
      }]
    };
    const search = vi.fn(async (): Promise<RecruitmentSiteSearchResult> => searchResult);
    const registry = createConversationToolRegistry(dependencies({ searchRecruitmentSites: search } as never));

    const result = await registry.invoke("discover_recruitment_site", {
      company: "Baidu",
      recruitmentType: "campus"
    }, context);

    expect(result.cards).toEqual([]);
    expect(result.recruitmentSearch).toEqual(searchResult);
    expect(search).toHaveBeenCalledWith({ companyName: "Baidu", recruitmentType: "campus" });

    search.mockRejectedValueOnce(new Error("discovery_failed"));
    await expect(registry.invoke("discover_recruitment_site", {
      company: "Baidu",
      recruitmentType: "campus"
    }, context)).rejects.toThrow("discovery_failed");
  });

  it("creates a job-match session only from the verified recruitment context", async () => {
    const create = vi.fn(async () => aggregate());
    const registry = createConversationToolRegistry(dependencies({
      jobMatchService: {
        create,
        select: vi.fn(),
        convert: vi.fn()
      }
    }));

    await expect(registry.invoke("create_job_match_session", {
      url: "https://attacker.example/"
    }, { ...context, verifiedRecruitmentSite: site })).rejects.toThrow("tool_input_invalid");
    expect(create).not.toHaveBeenCalled();

    const result = await registry.invoke("create_job_match_session", {}, {
      ...context,
      verifiedRecruitmentSite: site
    });
    expect(create).toHaveBeenCalledWith({ url: site.url });
    expect(result.cards).toEqual([
      expect.objectContaining({ type: "recruitment_site", url: site.url }),
      expect.objectContaining({ type: "job_match_session", sessionId: "match-1" })
    ]);
    expect(result.jobMatchSession?.sessionId).toBe("match-1");
  });
});
