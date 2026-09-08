import { describe, expect, it, vi } from "vitest";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import type { ConversationContext, ConversationTurnResponse, RecruitmentSiteSearchResult, VerifiedRecruitmentSite } from "@resume/contracts";
import type { JobMatchAggregate, JobMatchRepository } from "../job-matching/job-match-repository.js";
import { createConversationToolRegistry } from "./conversation-tools.js";
import { createConversationGraph, type ConversationGraphDependencies } from "./conversation-graph.js";
import { createConversationProcessEventBus } from "./conversation-events.js";

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
    orchestrator: "agent-runtime" as const,
    profileRevisionApplied: 0,
    profileSyncStatus: "current" as const
  }));
  const startApplication = vi.fn();
  const traceRecord = vi.fn(() => "trace-1");

  return {
    conversations: {
      linkJobMatchSession: vi.fn()
    },
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
    orchestrator: "agent-runtime" as const,
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
    turnSequence: 1,
    text,
    context
  });
  return state.response;
}

describe("conversation graph", () => {
  it("discovers a company recruitment entry and requires two explicit approvals before matching", async () => {
    const base = fakeDependencies();
    const candidate = {
      title: "Baidu Campus Recruitment",
      url: "https://campus.baidu.com/",
      domain: "campus.baidu.com",
      snippet: "Campus recruitment roles",
      source: "tavily" as const
    };
    const site: VerifiedRecruitmentSite = {
      company: "Baidu",
      recruitmentType: "campus",
      query: "Baidu campus recruitment official",
      ...candidate
    };
    const aggregate = base.jobMatchRepository.get("match-1");
    if (aggregate === undefined) throw new Error("fixture_missing");
    const searchRecruitmentSites = vi.fn(async (): Promise<RecruitmentSiteSearchResult> => ({
      query: site.query,
      candidates: [candidate]
    }));
    const create = vi.fn(async () => ({ ...aggregate, initialUrl: site.url }));
    const graph = createConversationGraph({
      ...base,
      searchRecruitmentSites,
      jobMatchService: {
        create,
        select: vi.fn(),
        convert: vi.fn()
      }
    });

    const discovered = (await graph.invoke({
      conversationId: "conversation-recruitment",
      turnSequence: 1,
      text: "帮我投递一下百度校园招聘",
      context: { version: 0, recentPostingIds: [] }
    })).response;
    expect(searchRecruitmentSites).toHaveBeenCalledWith({ companyName: "百度", recruitmentType: "campus" });
    expect(discovered.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "confirmation",
        confirmationId: discovered.confirmationId,
        action: "confirm_recruitment_site",
        target: expect.objectContaining({ kind: "recruitment_site_choices", candidates: [candidate] })
      })
    ]));
    expect(discovered.pendingConfirmation?.action).toBe("confirm_recruitment_site");
    expect(discovered.pendingConfirmation?.sourceTurnSequence).toBe(1);
    expect(discovered.context.verifiedRecruitmentSite).toBeUndefined();
    expect(create).not.toHaveBeenCalled();

    const selectedUrl = "https://campus.baidu.com/";
    const siteApproved = (await graph.invoke({
      conversationId: "conversation-recruitment",
      turnSequence: 2,
      confirmationId: discovered.confirmationId,
      approved: true,
      selectedUrl,
      context: discovered.context
    })).response;
    expect(siteApproved.context.verifiedRecruitmentSite?.url).toBe(selectedUrl);
    expect(siteApproved.pendingConfirmation?.action).toBe("request_job_recommendations");
    expect(siteApproved.pendingConfirmation?.sourceTurnSequence).toBe(2);
    expect(siteApproved.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "recruitment_site", url: site.url }),
      expect.objectContaining({ type: "confirmation", action: "request_job_recommendations" })
    ]));
    expect(create).not.toHaveBeenCalled();

    const matching = (await graph.invoke({
      conversationId: "conversation-recruitment",
      turnSequence: 3,
      confirmationId: siteApproved.confirmationId,
      approved: true,
      context: siteApproved.context
    })).response;
    expect(create).toHaveBeenCalledWith({ url: site.url });
    expect(matching.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "job_match_session", sessionId: "match-1" })
    ]));
    expect(matching.context.activeJobMatchSessionId).toBe("match-1");
  });

  it("does not create a matching session when the recruitment entry is declined", async () => {
    const base = fakeDependencies();
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
    const create = vi.fn(async () => base.jobMatchRepository.get("match-1")!);
    const graph = createConversationGraph({
      ...base,
      searchRecruitmentSites: vi.fn(async () => ({
        query: site.query,
        candidates: [{
          title: site.title,
          url: site.url,
          domain: site.domain,
          snippet: site.snippet,
          source: site.source
        }]
      })),
      jobMatchService: { create, select: vi.fn(), convert: vi.fn() }
    });
    const discovered = (await graph.invoke({
      conversationId: "conversation-recruitment-decline",
      turnSequence: 1,
      text: "我想投递百度校招",
      context: { version: 0, recentPostingIds: [] }
    })).response;
    const declined = (await graph.invoke({
      conversationId: "conversation-recruitment-decline",
      turnSequence: 2,
      confirmationId: discovered.confirmationId,
      approved: false,
      context: discovered.context
    })).response;

    expect(declined.pendingConfirmation).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(declined.context.activeJobMatchSessionId).toBeUndefined();
  });

  it("rejects a selected URL that is not one of the pending candidates", async () => {
    const base = fakeDependencies();
    const searchRecruitmentSites = vi.fn(async (): Promise<RecruitmentSiteSearchResult> => ({
      query: "百度 校园招聘 招聘 官网",
      candidates: [{
        title: "百度校园招聘",
        url: "https://campus.baidu.com/",
        domain: "campus.baidu.com",
        snippet: "校园招聘岗位",
        source: "tavily"
      }]
    }));
    const graph = createConversationGraph({ ...base, searchRecruitmentSites });
    const discovered = (await graph.invoke({
      conversationId: "conversation-recruitment-invalid-selection",
      turnSequence: 1,
      text: "帮我投递百度校园招聘",
      context: { version: 0, recentPostingIds: [] }
    })).response;

    const rejected = (await graph.invoke({
      conversationId: "conversation-recruitment-invalid-selection",
      turnSequence: 2,
      confirmationId: discovered.confirmationId,
      approved: true,
      selectedUrl: "https://attacker.example/",
      context: discovered.context
    })).response;

    expect(rejected.message.text).toContain("所选招聘入口已失效");
    expect(rejected.context.verifiedRecruitmentSite).toBeUndefined();
    expect(rejected.pendingConfirmation).toBeUndefined();
  });

  it("turns a user-provided public HTTPS link into the same candidate confirmation", async () => {
    const base = fakeDependencies();
    const searchRecruitmentSites = vi.fn(async (): Promise<RecruitmentSiteSearchResult> => ({
      query: "百度 校园招聘 招聘 官网",
      candidates: [{
        title: "百度校园招聘",
        url: "https://campus.baidu.com/",
        domain: "campus.baidu.com",
        snippet: "校园招聘岗位",
        source: "tavily"
      }]
    }));
    const validatePublicHttpsUrl = vi.fn(async () => ({
      url: "https://jobs.baidu.com/",
      domain: "jobs.baidu.com"
    }));
    const graph = createConversationGraph({ ...base, searchRecruitmentSites, validatePublicHttpsUrl });
    const discovered = (await graph.invoke({
      conversationId: "conversation-recruitment-manual-link",
      turnSequence: 1,
      text: "帮我投递百度校园招聘",
      context: { version: 0, recentPostingIds: [] }
    })).response;

    const recovered = (await graph.invoke({
      conversationId: "conversation-recruitment-manual-link",
      turnSequence: 2,
      text: "官方入口是 https://jobs.baidu.com/",
      context: discovered.context
    })).response;

    expect(validatePublicHttpsUrl).toHaveBeenCalledWith("https://jobs.baidu.com/");
    expect(searchRecruitmentSites).toHaveBeenCalledOnce();
    expect(recovered.pendingConfirmation?.target).toMatchObject({
      kind: "recruitment_site_choices",
      candidates: [{ source: "user", url: "https://jobs.baidu.com/" }]
    });
    expect(recovered.context.verifiedRecruitmentSite).toBeUndefined();
  });

  it("routes an explicit filling URL ahead of stale recruitment context", async () => {
    const base = fakeDependencies();
    base.createFromJob.mockImplementation((input: { id: string; applicationUrl: string }) => ({
      ...input,
      name: "Direct application",
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
      orchestrator: "agent-runtime" as const,
      profileRevisionApplied: 0,
      profileSyncStatus: "current" as const
    }));
    const searchRecruitmentSites = vi.fn();
    const createJobMatchSession = vi.fn();
    const validatePublicHttpsUrl = vi.fn(async (url: string) => ({
      url,
      domain: "jobs.example.com"
    }));
    const graph = createConversationGraph({
      ...base,
      searchRecruitmentSites,
      validatePublicHttpsUrl,
      jobMatchService: {
        create: createJobMatchSession,
        select: vi.fn(),
        convert: vi.fn()
      }
    });
    const context: ConversationContext = {
      version: 1,
      recentPostingIds: [],
      lastRecruitmentRequest: { companyName: "百度", recruitmentType: "campus" }
    };

    const response = (await graph.invoke({
      conversationId: "conversation-direct-application-url",
      turnSequence: 2,
      text: "填写 https://jobs.example.com/apply/123",
      context
    })).response;

    expect(response.message.intent).toMatchObject({
      kind: "start_application",
      target: { kind: "application_url", url: "https://jobs.example.com/apply/123" }
    });
    expect(response.pendingConfirmation?.target).toMatchObject({ kind: "application_url" });
    expect(validatePublicHttpsUrl).toHaveBeenCalledWith("https://jobs.example.com/apply/123");
    expect(searchRecruitmentSites).not.toHaveBeenCalled();
    expect(createJobMatchSession).not.toHaveBeenCalled();

    const confirmed = (await graph.invoke({
      conversationId: "conversation-direct-application-url",
      turnSequence: 3,
      confirmationId: response.confirmationId!,
      approved: true,
      context: response.context
    })).response;

    expect(base.createFromJob).toHaveBeenCalledWith(expect.objectContaining({
      applicationUrl: "https://jobs.example.com/apply/123"
    }));
    expect(base.startApplication).toHaveBeenCalledWith(expect.objectContaining({
      applicationUrl: "https://jobs.example.com/apply/123"
    }));
    expect(confirmed.cards[0]).toMatchObject({
      type: "application_task",
      applicationUrl: "https://jobs.example.com/apply/123"
    });
  });

  it("asks for purpose when a bare URL follows recruitment context", async () => {
    const base = fakeDependencies();
    const searchRecruitmentSites = vi.fn();
    const graph = createConversationGraph({ ...base, searchRecruitmentSites });

    const response = (await graph.invoke({
      conversationId: "conversation-ambiguous-url",
      turnSequence: 2,
      text: "https://jobs.example.com/apply/456",
      context: {
        version: 1,
        recentPostingIds: [],
        lastRecruitmentRequest: { companyName: "百度", recruitmentType: "campus" }
      }
    })).response;

    expect(response.message.text).toContain("你想填写这个申请页面，还是用它进行岗位推荐");
    expect(response.pendingConfirmation).toBeUndefined();
    expect(searchRecruitmentSites).not.toHaveBeenCalled();
    expect(base.createFromJob).not.toHaveBeenCalled();
    expect(base.startApplication).not.toHaveBeenCalled();
  });

  it.each([
    ["帮我投递百度社会招聘", "social" as const],
    ["帮我看看腾讯实习招聘", "internship" as const],
    ["查找大疆招聘官网", "unknown" as const]
  ])("maps %s to the shared recruitment search type", async (text, recruitmentType) => {
    const base = fakeDependencies();
    const searchRecruitmentSites = vi.fn(async (): Promise<RecruitmentSiteSearchResult> => ({
      query: "招聘",
      candidates: [{
        title: "招聘入口",
        url: "https://jobs.example.com/",
        domain: "jobs.example.com",
        snippet: "招聘岗位",
        source: "tavily"
      }]
    }));
    const response = (await createConversationGraph({ ...base, searchRecruitmentSites }).invoke({
      conversationId: `conversation-${recruitmentType}`,
      turnSequence: 1,
      text,
      context: { version: 0, recentPostingIds: [] }
    })).response;

    expect(response.message.intent?.target?.recruitmentType).toBe(recruitmentType);
    expect(searchRecruitmentSites).toHaveBeenCalledWith(expect.objectContaining({ recruitmentType }));
  });

  it("does not expose arbitrary browser operations", async () => {
    const { registry } = createRegistryDependencies();

    expect(registry.names()).toEqual([
      "discover_recruitment_site",
      "create_job_match_session",
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
    expect(response.pendingConfirmation?.target).toMatchObject({
      kind: "recommendation",
      resultId: "result-1"
    });
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

  it("keeps an unambiguous application-status intent ahead of a conflicting model result", async () => {
    const dependencies = fakeDependencies();
    const generateStructured = vi.fn(async () => ({
      kind: "list_recommendations",
      requiresConfirmation: false
    }));
    dependencies.modelProvider = { generateStructured };

    const response = await runConversationTurn(
      dependencies,
      "我投了哪些岗位？对应的网站有哪些？",
      { version: 0, recentPostingIds: [] }
    );

    expect(response.message.intent?.kind).toBe("list_application_tasks");
    expect(response.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "application_task" })
    ]));
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("uses the structured model when deterministic rules do not understand the message", async () => {
    const dependencies = fakeDependencies();
    const generateStructured = vi.fn(async () => ({
      kind: "list_recommendations",
      requiresConfirmation: false
    }));
    dependencies.modelProvider = { generateStructured };

    const response = await runConversationTurn(
      dependencies,
      "帮我做点别的事情",
      { version: 0, recentPostingIds: [] }
    );

    expect(response.message.intent?.kind).toBe("list_recommendations");
    expect(generateStructured).toHaveBeenCalledTimes(1);
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

  it("emits visible process stages while searching a recruitment entry", async () => {
    const dependencies = fakeDependencies();
    const processEvents = createConversationProcessEventBus();
    const candidate = {
      title: "Baidu Campus Recruitment",
      url: "https://campus.baidu.com/",
      domain: "campus.baidu.com",
      snippet: "Campus recruitment roles",
      source: "tavily" as const
    };
    const searchRecruitmentSites = vi.fn(async () => ({
      query: "百度 校园招聘 招聘 官网",
      candidates: [candidate]
    }));

    const graph = createConversationGraph({
      ...dependencies,
      processEvents,
      searchRecruitmentSites,
      jobMatchService: {
        create: vi.fn(async () => dependencies.jobMatchRepository.get("match-1")!),
        select: vi.fn(),
        convert: vi.fn()
      }
    } as never);
    const discovered = await graph.invoke({
      conversationId: "conversation-process",
      turnSequence: 1,
      text: "帮我投递百度校园招聘",
      context: { version: 0, recentPostingIds: [] }
    });
    const siteApproved = await graph.invoke({
      conversationId: "conversation-process",
      turnSequence: 2,
      confirmationSourceTurnSequence: 1,
      confirmationId: discovered.response.confirmationId,
      approved: true,
      selectedUrl: candidate.url,
      context: discovered.response.context
    });
    await graph.invoke({
      conversationId: "conversation-process",
      turnSequence: 3,
      confirmationSourceTurnSequence: 2,
      confirmationId: siteApproved.response.confirmationId,
      approved: true,
      context: siteApproved.response.context
    });

    const events = processEvents.replay("conversation-process").events;
    const firstTurn = events.filter((event) => event.turnSequence === 1);
    expect(firstTurn.map(({ stage, status }) => [stage, status])).toEqual([
      ["understanding_request", "running"],
      ["understanding_request", "completed"],
      ["searching_recruitment_site", "running"],
      ["searching_recruitment_site", "completed"],
      ["validating_recruitment_site", "running"],
      ["validating_recruitment_site", "completed"],
      ["waiting_for_confirmation", "running"],
      ["waiting_for_confirmation", "waiting"],
      ["generating_response", "running"],
      ["generating_response", "completed"]
    ]);
    const tavilyLifecycle = firstTurn.filter((event) => event.tool?.name === "tavily_search");
    expect(new Set(tavilyLifecycle.map(({ stepId }) => stepId)).size).toBe(1);
    expect(firstTurn.find((event) => event.tool?.name === "tavily_search")?.tool).toEqual(expect.objectContaining({
      result: expect.any(String)
    }));
    expect(JSON.stringify(firstTurn)).not.toMatch(/tavilyApiKey|authorization|cookie|rawResponse/i);
    expect(new Set(events.filter((event) => event.turnSequence === 3).map(({ stepId }) => stepId)).size).toBeGreaterThan(1);
  });

  it("shows a response lifecycle for ordinary chat without inventing a tool call", async () => {
    const processEvents = createConversationProcessEventBus();
    const graph = createConversationGraph({ ...fakeDependencies(), processEvents } as never);

    await graph.invoke({
      conversationId: "conversation-ordinary",
      turnSequence: 1,
      text: "你好",
      context: { version: 0, recentPostingIds: [] }
    });

    const events = processEvents.replay("conversation-ordinary").events;
    expect(events.map(({ stage, status }) => [stage, status])).toEqual([
      ["understanding_request", "running"],
      ["understanding_request", "completed"],
      ["generating_response", "running"],
      ["generating_response", "completed"]
    ]);
    expect(events.some((event) => event.tool !== undefined)).toBe(false);
  });

  it("records a sanitized failed tool step without changing the response", async () => {
    const dependencies = fakeDependencies();
    dependencies.applicationTasks.list = vi.fn(() => {
      throw new Error("application_task_unavailable");
    });
    const processEvents = createConversationProcessEventBus();
    const graph = createConversationGraph({ ...dependencies, processEvents } as never);

    const response = await graph.invoke({
      conversationId: "conversation-tool-failure",
      turnSequence: 1,
      text: "我投了哪些岗位",
      context: { version: 0, recentPostingIds: [] }
    });

    const failure = processEvents.replay("conversation-tool-failure").events
      .find((event) => event.stage === "loading_application_progress" && event.status === "failed");
    expect(failure).toMatchObject({
      tool: { name: "application_progress" },
      failure: { code: "PROCESS_STEP_FAILED", retryable: true }
    });
    expect(response.response.message.text).toContain("无法");
  });

  it("explains missing job expectations and ends the process chain when matching fails", async () => {
    const dependencies = fakeDependencies();
    const processEvents = createConversationProcessEventBus();
    const candidate = {
      title: "百度校园招聘",
      url: "https://campus.baidu.com/",
      domain: "campus.baidu.com",
      snippet: "校园招聘岗位",
      source: "tavily" as const
    };
    const create = vi.fn(async () => {
      throw new Error("job_expectation_required");
    });
    const graph = createConversationGraph({
      ...dependencies,
      processEvents,
      searchRecruitmentSites: vi.fn(async () => ({
        query: "百度 招聘 招聘 官网",
        candidates: [candidate]
      })),
      jobMatchService: {
        create,
        select: vi.fn(),
        convert: vi.fn()
      }
    });

    const discovered = await graph.invoke({
      conversationId: "conversation-missing-expectation",
      turnSequence: 1,
      text: "帮我投递百度",
      context: { version: 0, recentPostingIds: [] }
    });
    const siteApproved = await graph.invoke({
      conversationId: "conversation-missing-expectation",
      turnSequence: 2,
      confirmationId: discovered.response.confirmationId,
      approved: true,
      selectedUrl: candidate.url,
      context: discovered.response.context
    });
    const failed = await graph.invoke({
      conversationId: "conversation-missing-expectation",
      turnSequence: 3,
      confirmationId: siteApproved.response.confirmationId,
      approved: true,
      context: siteApproved.response.context
    });

    expect(failed.response.message.text).toBe(
      "开始岗位推荐前，请先补充并确认岗位期望（例如工作城市或职位方向）。"
    );
    expect(create).toHaveBeenCalledWith({ url: candidate.url });
    const events = processEvents.replay("conversation-missing-expectation").events;
    expect(events.slice(-5).map(({ stage, status }) => ({ stage, status }))).toEqual([
      { stage: "processing_confirmation", status: "running" },
      { stage: "creating_job_match_session", status: "running" },
      { stage: "creating_job_match_session", status: "failed" },
      { stage: "processing_confirmation", status: "failed" },
      { stage: "failed", status: "failed" }
    ]);
    expect(events.at(-1)).toMatchObject({ stage: "failed", status: "failed" });
  });

  it("explains an unsupported job entry instead of returning a generic failure", async () => {
    const dependencies = fakeDependencies();
    const candidate = {
      title: "百度校园招聘",
      url: "https://talent.baidu.com/",
      domain: "talent.baidu.com",
      snippet: "校园招聘岗位",
      source: "tavily" as const
    };
    const create = vi.fn(async () => {
      throw new Error("unsupported_job_entry");
    });
    const graph = createConversationGraph({
      ...dependencies,
      searchRecruitmentSites: vi.fn(async () => ({
        query: "百度 校园招聘 招聘 官网",
        candidates: [candidate]
      })),
      jobMatchService: {
        create,
        select: vi.fn(),
        convert: vi.fn()
      }
    });

    const discovered = await graph.invoke({
      conversationId: "conversation-unsupported-entry",
      turnSequence: 1,
      text: "帮我投递百度",
      context: { version: 0, recentPostingIds: [] }
    });
    const siteApproved = await graph.invoke({
      conversationId: "conversation-unsupported-entry",
      turnSequence: 2,
      confirmationId: discovered.response.confirmationId,
      approved: true,
      selectedUrl: candidate.url,
      context: discovered.response.context
    });
    const failed = await graph.invoke({
      conversationId: "conversation-unsupported-entry",
      turnSequence: 3,
      confirmationId: siteApproved.response.confirmationId,
      approved: true,
      context: siteApproved.response.context
    });

    expect(failed.response.message.text).toBe(
      "当前招聘页面结构尚未识别，请确认链接打开的是岗位列表或岗位详情页。"
    );
    expect(failed.response.message.text).not.toContain("这项操作暂时无法完成");
    expect(create).toHaveBeenCalledWith({ url: candidate.url });
  });

  it("explains controlled-browser contention instead of returning a generic failure", async () => {
    const dependencies = fakeDependencies();
    const candidate = {
      title: "百度校园招聘",
      url: "https://talent.baidu.com/",
      domain: "talent.baidu.com",
      snippet: "校园招聘岗位",
      source: "tavily" as const
    };
    const create = vi.fn(async () => {
      throw new Error("browser_lease_in_use");
    });
    const graph = createConversationGraph({
      ...dependencies,
      searchRecruitmentSites: vi.fn(async () => ({
        query: "百度 校园招聘 招聘 官网",
        candidates: [candidate]
      })),
      jobMatchService: {
        create,
        select: vi.fn(),
        convert: vi.fn()
      }
    });

    const discovered = await graph.invoke({
      conversationId: "conversation-browser-contention",
      turnSequence: 1,
      text: "帮我投递百度",
      context: { version: 0, recentPostingIds: [] }
    });
    const siteApproved = await graph.invoke({
      conversationId: "conversation-browser-contention",
      turnSequence: 2,
      confirmationId: discovered.response.confirmationId,
      approved: true,
      selectedUrl: candidate.url,
      context: discovered.response.context
    });
    const failed = await graph.invoke({
      conversationId: "conversation-browser-contention",
      turnSequence: 3,
      confirmationId: siteApproved.response.confirmationId,
      approved: true,
      context: siteApproved.response.context
    });

    expect(failed.response.message.text).toBe(
      "受控浏览器正在处理其他岗位匹配或投递任务，请等待当前任务完成或先暂停它后再试。"
    );
    expect(failed.traceIds).not.toHaveLength(0);
    expect(create).toHaveBeenCalledWith({ url: candidate.url });
  });

  it("explains a normalized job match execution failure instead of returning a generic failure", async () => {
    const dependencies = fakeDependencies();
    const candidate = {
      title: "百度校园招聘",
      url: "https://talent.baidu.com/",
      domain: "talent.baidu.com",
      snippet: "校园招聘岗位",
      source: "tavily" as const
    };
    const create = vi.fn(async () => {
      throw new Error("browser_observation_failed: page unavailable");
    });
    const graph = createConversationGraph({
      ...dependencies,
      searchRecruitmentSites: vi.fn(async () => ({
        query: "百度 校园招聘 招聘 官网",
        candidates: [candidate]
      })),
      jobMatchService: {
        create,
        select: vi.fn(),
        convert: vi.fn()
      }
    });

    const discovered = await graph.invoke({
      conversationId: "conversation-normalized-create-failure",
      turnSequence: 1,
      text: "帮我投递百度",
      context: { version: 0, recentPostingIds: [] }
    });
    const siteApproved = await graph.invoke({
      conversationId: "conversation-normalized-create-failure",
      turnSequence: 2,
      confirmationId: discovered.response.confirmationId,
      approved: true,
      selectedUrl: candidate.url,
      context: discovered.response.context
    });
    const failed = await graph.invoke({
      conversationId: "conversation-normalized-create-failure",
      turnSequence: 3,
      confirmationId: siteApproved.response.confirmationId,
      approved: true,
      context: siteApproved.response.context
    });

    expect(failed.response.message.text).toBe(
      "岗位推荐执行失败，请检查受控浏览器和招聘页面后重试。"
    );
    expect(failed.response.message.text).not.toContain("这项操作暂时无法完成");
  });

  it("uses the configured checkpoint saver for conversation state", async () => {
    const dependencies = fakeDependencies();
    const checkpointer = new MemorySaver();
    const graph = createConversationGraph({ ...dependencies, checkpointer });

    await graph.invoke({
      conversationId: "conversation-1",
      turnSequence: 1,
      text: "我投了哪些岗位",
      context: { version: 0, recentPostingIds: [] }
    }, { configurable: { thread_id: "conversation-1" } });

    await expect(checkpointer.getTuple({ configurable: { thread_id: "conversation-1" } }))
      .resolves.toBeDefined();
  });

  it("treats a new message as a message after a prior checkpointed confirmation", async () => {
    const dependencies = fakeDependencies();
    const searchRecruitmentSites = vi.fn(async () => ({
      query: "百度 招聘 招聘 官网",
      candidates: [{
        title: "百度校园招聘",
        url: "https://campus.baidu.com/",
        domain: "campus.baidu.com",
        snippet: "校园招聘岗位",
        source: "tavily" as const
      }]
    }));
    const checkpointer = new MemorySaver();
    const graph = createConversationGraph({ ...dependencies, checkpointer, searchRecruitmentSites });
    const config = { configurable: { thread_id: "conversation-checkpoint-input-reset" } };

    const discovered = await graph.invoke({
      conversationId: "conversation-checkpoint-input-reset",
      turnSequence: 1,
      text: "帮我投递百度",
      context: { version: 0, recentPostingIds: [] }
    }, config);
    expect(discovered.response.pendingConfirmation?.action).toBe("confirm_recruitment_site");

    const status = await graph.invoke({
      conversationId: "conversation-checkpoint-input-reset",
      turnSequence: 2,
      text: "我投了哪些岗位",
      context: discovered.response.context
    }, config);

    expect(status.response.message.intent?.kind).toBe("list_application_tasks");
    expect(status.response.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "application_task" })
    ]));
    expect(status.response.pendingConfirmation).toBeUndefined();
  });
});
