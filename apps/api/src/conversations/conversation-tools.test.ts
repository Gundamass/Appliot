import { describe, expect, it, vi } from "vitest";
import type { JobMatchResult, JobPosting, RecruitmentSiteSearchResult, VerifiedRecruitmentSite } from "@resume/contracts";
import type { JobMatchAggregate, JobMatchRepository } from "../job-matching/job-match-repository.js";
import { prepareApplicationTarget } from "../applications/application-target.js";
import type { StoredApplicationTask } from "../applications/application-task-repository.js";
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

function aggregateWithResults(): JobMatchAggregate {
  const jobs: JobPosting[] = Array.from({ length: 8 }, (_value, index) => ({
    id: `posting-${index + 1}`,
    source: "baidu",
    canonicalUrl: `https://talent.baidu.com/jobs/${index + 1}`,
    title: `Frontend Engineer ${index + 1}`,
    organization: "Baidu",
    description: "Frontend role",
    requirements: [],
    adapterVersion: "baidu-campus-v1",
    contentHash: `sha256:posting-${index + 1}`,
    extractedAt: "2026-08-24T00:00:00.000Z"
  }));
  const results: JobMatchResult[] = jobs.map((job, index) => ({
    id: `result-${index + 1}`,
    version: 0,
    sessionId: "match-1",
    postingId: job.id,
    fitScore: 90 - index,
    confidence: 80,
    rankingScore: 80 - index,
    outcomes: [],
    evidence: [],
    gaps: [],
    scoringVersion: "job-match-v1",
    profileRevision: 0,
    expectationRevision: 0,
    postingContentHash: job.contentHash,
    stale: false
  }));
  return { ...aggregate(), state: "awaiting_job_selection", postings: jobs, results };
}

function dependencies(overrides: Partial<ConversationToolDependencies> = {}): ConversationToolDependencies {
  return {
    conversations: { linkJobMatchSession: vi.fn() },
    jobMatchRepository: { get: vi.fn(() => aggregate()) } as Pick<JobMatchRepository, "get">,
    applicationTasks: {
      list: vi.fn(() => []),
      get: vi.fn(),
      createFromJob: vi.fn()
    },
    prepareApplicationTarget: (rawUrl, identity) => prepareApplicationTarget(rawUrl, identity, async () => ["220.181.7.203"]),
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

  it("links a newly created job-match session to the current conversation", async () => {
    const linkJobMatchSession = vi.fn();
    const create = vi.fn(async () => aggregate());
    const registry = createConversationToolRegistry(dependencies({
      conversations: { linkJobMatchSession },
      jobMatchService: {
        create,
        select: vi.fn(),
        convert: vi.fn()
      }
    }));

    await registry.invoke("create_job_match_session", {}, {
      ...context,
      conversationId: "conversation-link-test",
      verifiedRecruitmentSite: site
    });

    expect(linkJobMatchSession).toHaveBeenCalledWith("conversation-link-test", "match-1");
  });

  it("caps recommendation cards at the six highest-ranked results", async () => {
    const value = aggregateWithResults();
    const registry = createConversationToolRegistry(dependencies({
      jobMatchRepository: { get: vi.fn(() => value) } as Pick<JobMatchRepository, "get">,
      jobMatchService: {
        create: vi.fn(async () => value),
        select: vi.fn(),
        convert: vi.fn()
      }
    }));

    const listed = await registry.invoke("list_recommendations", { sessionId: value.id }, context);
    const created = await registry.invoke("create_job_match_session", {}, {
      ...context,
      verifiedRecruitmentSite: site
    });

    expect(listed.cards.filter((card) => card.type === "recommendation")).toHaveLength(6);
    expect(created.cards.filter((card) => card.type === "recommendation")).toHaveLength(6);
  });

  it("canonicalizes, creates, and starts an idempotent controlled application task from a direct URL", async () => {
    let stored: StoredApplicationTask | undefined;
    const createFromJob = vi.fn((input: { id: string; name?: string; applicationUrl: string }): StoredApplicationTask => ({
      ...input,
      name: input.name ?? "example.com 申请",
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
      orchestrator: "agent-runtime" as const,
      profileRevisionApplied: 0,
      profileSyncStatus: "current" as const
    }));
    createFromJob.mockImplementation((input) => stored ??= ({
      ...input,
      name: input.name ?? "example.com 申请",
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
      orchestrator: "agent-runtime" as const,
      profileRevisionApplied: 0,
      profileSyncStatus: "current" as const
    }));
    const start = vi.fn();
    const registry = createConversationToolRegistry(dependencies({
      applicationTasks: { list: vi.fn(() => stored ? [stored] : []), get: vi.fn(() => stored), createFromJob },
      applicationService: { start }
    }));
    const polluted = "https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440%E8%BF%99%E4%B8%AA%E9%A1%B5%E9%9D%A2%E5%8F%AF%E4%BB%A5%E6%8A%95%E9%80%92%E5%90%97";
    const clean = "https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440";

    const first = await registry.invoke("create_application_task", { applicationUrl: polluted }, context);
    await registry.invoke("create_application_task", { applicationUrl: clean }, context);

    expect(createFromJob).toHaveBeenCalledTimes(1);
    const firstTaskId = createFromJob.mock.calls[0]![0].id;
    expect(firstTaskId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(createFromJob).toHaveBeenCalledWith(expect.objectContaining({ applicationUrl: clean }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ applicationUrl: clean }));
    expect(first.cards[0]).toMatchObject({
      type: "application_task",
      taskId: firstTaskId,
      applicationUrl: clean
    });
  });

  it("rejects a malformed direct application URL as invalid tool input", async () => {
    const registry = createConversationToolRegistry(dependencies());

    await expect(registry.invoke("create_application_task", {
      applicationUrl: "not-a-url"
    }, context)).rejects.toThrow("tool_input_invalid");
  });
});
