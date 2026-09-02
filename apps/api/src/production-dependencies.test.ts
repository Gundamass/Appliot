import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FormField,
  FormSnapshot,
  JobPageSnapshot,
  ProfileFact,
  WorkerActivity
} from "@resume/contracts";
import { createRagService, type ProfileRepositoryPort } from "@resume/rag";
import type { FieldSemanticResolver } from "./applications/field-semantic-resolver.js";
import { createApplicationTaskRepository } from "./applications/application-task-repository.js";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
const fixtureNodeRef = {
  documentId: "document-fixture-00000001",
  nodeId: "node-fixture-000000000001",
  observedAt: 7
};



const fakes = vi.hoisted(() => ({
  databases: [] as Array<{ closeCalls: number }>,
  migrationFailure: undefined as Error | undefined
}));

vi.mock("./db/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db/client.js")>()),
  createSqliteDatabase: vi.fn((filename: string) => {
    const database = new Database(filename);
    const tracker = { closeCalls: 0 };
    const close = database.close.bind(database);
    database.close = () => {
      tracker.closeCalls += 1;
      return close();
    };
    fakes.databases.push(tracker);
    return database;
  })
}));
vi.mock("./db/migrate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db/migrate.js")>();
  return {
    ...actual,
    migrateDatabase(database: Parameters<typeof actual.migrateDatabase>[0]) {
      if (fakes.migrationFailure) throw fakes.migrationFailure;
      actual.migrateDatabase(database);
    }
  };
});
const {
  createProductionDependencies,
  createProductionFieldResolver,
  fieldPathForApplicationAnswer
} = await import("./production-dependencies.js");

const QWEN_REVISION = "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af";
const OCR_REVISION = "aaa02f3811945a91062062994c5c4a3f4c0af2b0";

function fullConfig() {
  return loadConfig({
    DATABASE_FILE: ":memory:",
    DEEPSEEK_API_KEY: "deepseek-test-token",
    EMBEDDING_BASE_URL: "http://127.0.0.1:18080",
    EMBEDDING_API_TOKEN: "embedding-test-token",
    EMBEDDING_MODEL: "Qwen/Qwen3-Embedding-8B",
    EMBEDDING_MODEL_REVISION: QWEN_REVISION,
    EMBEDDING_DIMENSIONS: "4096",
    OCR_BASE_URL: "http://127.0.0.1:43121",
    OCR_API_TOKEN: "ocr-test-token",
    OCR_MODEL: "deepseek-ai/DeepSeek-OCR-2",
    OCR_MODEL_REVISION: OCR_REVISION
  });
}

describe("production dependency composition", () => {
  it("exposes a trusted attestation provider that issues scoped tokens on demand", async () => {
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: productionBrowserClient()
    });
    try {
      expect(dependencies.agentCallerAttestationProvider).toBeDefined();
      expect(dependencies.agentCallerAttestationVerifier).toBeDefined();
      const first = dependencies.agentCallerAttestationProvider.issue("runtime");
      const second = dependencies.agentCallerAttestationProvider.issue("runtime");
      expect(first).not.toBe(second);
      expect(dependencies.agentCallerAttestationVerifier.verify(first)).toMatchObject({ valid: true, caller: "runtime" });
      expect(dependencies.agentCallerAttestationVerifier.verify(second)).toMatchObject({ valid: true, caller: "runtime" });
      // A fixed startup token set must not be part of the production boundary.
      expect("agentCallerAttestations" in dependencies).toBe(false);
    } finally {
      await dependencies.close?.();
    }
  });

  it("composes and exposes the inline conversation job-match action service", async () => {
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: productionBrowserClient()
    });

    expect(dependencies.conversationJobMatchService).toBeDefined();
    const app = await createApp(dependencies);
    try {
      const created = await app.inject({ method: "POST", url: "/api/conversations" });
      const conversationId = created.json().id as string;
      const response = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/job-match-actions`,
        payload: {
          conversationId,
          sessionId: "33333333-3333-4333-8333-333333333333",
          action: "pause",
          sessionVersion: 0,
          idempotencyKey: "composition-1"
        }
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "job_match_session_not_found" });
    } finally {
      await app.close();
    }
  });

  it("composes job matching from confirmed knowledge-base expectations with the shared browser lease", async () => {
    const browserClient = productionBrowserClient();
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient
    });
    const preferences = [
      confirmedProfileFact("preferences.targetRole", "Java Tech Lead"),
      confirmedProfileFact("preferences.location", "Legacy City"),
      confirmedProfileFact("preferences.targetCity", "Shanghai"),
      confirmedProfileFact("preferences.employmentType", "Full-time"),
      confirmedProfileFact("preferences.industry", "Software"),
      confirmedProfileFact("preferences.workMode", "Hybrid"),
      confirmedProfileFact("preferences.salary", "30k-40k")
    ];
    for (const preference of preferences) {
      dependencies.profileRepository.createExtracted({ ...preference, status: "extracted" });
      dependencies.profileRepository.confirm(preference.id);
    }

    const created = await dependencies.jobMatchService.create({ url: "https://acme.mokahr.com/jobs" });
    expect(created).toMatchObject({
      version: 0,
      state: "awaiting_filter_confirmation",
      expectation: {
        criteria: [
          { kind: "target_role", values: ["Java Tech Lead"], strength: "required" },
          { kind: "location", values: ["Shanghai"], strength: "required" },
          { kind: "employment_type", values: ["Full-time"], strength: "required" },
          { kind: "industry", values: ["Software"], strength: "required" },
          { kind: "work_mode", values: ["Hybrid"], strength: "required" },
          { kind: "salary", values: ["30k-40k"], strength: "required" }
        ]
      }
    });
    expect(dependencies.jobMatchRepository).toBeDefined();
    expect(dependencies.jobMatchTrace.snapshot()).toEqual(expect.any(Array));

    const taskId = "53288af7-7fcc-4624-861e-aa764ef65ec8";
    dependencies.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });
    await expect(dependencies.applicationService!.openBrowser(taskId)).rejects.toThrow("browser_task_in_use");
    expect(browserClient.execute).not.toHaveBeenCalled();
    await dependencies.close?.();
  });

  it("shares one browser ownership lease with the application service", async () => {
    const browserClient = productionBrowserClient();
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient
    });
    dependencies.browserOwnershipLease.acquire({ ownerKind: "job_match", ownerId: "jm-1" });
    const taskId = "53288af7-7fcc-4624-861e-aa764ef65ec8";
    dependencies.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });

    await expect(dependencies.applicationService!.openBrowser(taskId)).rejects.toThrow("browser_task_in_use");
    expect(browserClient.open).not.toHaveBeenCalled();
    await dependencies.close?.();
  });

  it("registers the Baidu campus adapter in the production job-matching service", async () => {
    const browserClient = productionBrowserClient({
      observeJob: vi.fn(async (ownerId: string): Promise<JobPageSnapshot> => ({
        id: `baidu-snapshot-${ownerId}`,
        ownerId,
        url: "https://talent.baidu.com/jobs/list?projectType=3&recruitType=GRADUATE",
        title: "百度校园招聘",
        capturedAt: "2026-08-24T00:00:00.000Z",
        entryHint: "job_list",
        visibleText: ["职位列表"],
        jobCards: [],
        filterState: [],
        pagination: { kind: "none", hasNext: false },
        boundaries: []
      }))
    });
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient
    });
    const expectation = confirmedProfileFact("preferences.targetRole", "技术");
    dependencies.profileRepository.createExtracted({ ...expectation, status: "extracted" });
    dependencies.profileRepository.confirm(expectation.id);

    const created = await dependencies.jobMatchService.create({
      url: "https://talent.baidu.com/jobs/list?projectType=3&recruitType=GRADUATE"
    });

    expect(created).toMatchObject({
      source: "baidu",
      adapterVersion: "baidu-job-v1",
      entryKind: "job_list"
    });
    await dependencies.close?.();
  });

  it("does not start a browser to search for a recruitment site", async () => {
    const browserClientFactory = vi.fn(async () => productionBrowserClient());
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClientFactory
    });
    const app = await createApp(dependencies);

    try {
      const created = await app.inject({ method: "POST", url: "/api/conversations" });
      const sessionId = created.json().id as string;
      const response = await app.inject({
        method: "POST",
        url: `/api/conversations/${sessionId}/messages`,
        payload: { text: "\u5e2e\u6211\u6295\u9012\u4e00\u4e0b\u767e\u5ea6\u6821\u56ed\u62db\u8058" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().pendingConfirmation).toBeUndefined();
      expect(response.json().message.text).toContain("联网搜索尚未配置");
      expect(browserClientFactory).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("uses the configured Tavily recruitment port before any browser worker starts", async () => {
    const browserClientFactory = vi.fn(async () => productionBrowserClient());
    const search = vi.fn(async (input: { companyName: string; recruitmentType: "campus" | "social" | "internship" | "unknown" }) => ({
      query: `${input.companyName} ${input.recruitmentType}`,
      candidates: [{
        title: "百度校园招聘",
        url: "https://talent.baidu.com/",
        domain: "talent.baidu.com",
        snippet: "校园招聘岗位",
        source: "tavily" as const
      }]
    }));
    const dependencies = createProductionDependencies(loadConfig({
      DATABASE_FILE: ":memory:",
      TAVILY_API_KEY: "tvly-test-key"
    }), {
      browserClientFactory,
      recruitmentSiteSearch: { search } as never
    });
    const app = await createApp(dependencies);

    try {
      const created = await app.inject({ method: "POST", url: "/api/conversations" });
      const sessionId = created.json().id as string;
      const response = await app.inject({
        method: "POST",
        url: `/api/conversations/${sessionId}/messages`,
        payload: { text: "帮我投递百度校园招聘" }
      });

      expect(response.statusCode).toBe(200);
      expect(search).toHaveBeenCalledWith({ companyName: "百度", recruitmentType: "campus" });
      expect(response.json().pendingConfirmation.target.kind).toBe("recruitment_site_choices");
      expect(browserClientFactory).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("restores a graph-owned application task after rebuilding production dependencies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "resume-langgraph-restart-"));
    const databaseFile = join(directory, "resume.db");
    const taskId = "2b9c0bfb-3785-4393-8e57-2a3082f29e3c";
    const config = loadConfig({ DATABASE_FILE: databaseFile });
    const firstBrowser = productionBrowserClient();
    const first = createProductionDependencies(config, { browserClient: firstBrowser });

    try {
      createApplicationTaskRepository(first.database).create({
        id: taskId,
        applicationUrl: "https://jobs.example.test/apply"
      });
      first.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });
      await first.applicationService!.openBrowser(taskId);
      await first.applicationService!.runUntilPause(taskId);
      expect(first.applicationService!.state(taskId).value).toBe("awaiting_login");
      const graphCheckpointCount = first.database.prepare(
        "SELECT COUNT(*) AS count FROM agent_checkpoints WHERE thread_id = ?"
      ).get(`application:${taskId}`) as { count: number };
      const legacyCheckpointCount = first.database.prepare(
        "SELECT COUNT(*) AS count FROM application_checkpoints WHERE task_id = ?"
      ).get(taskId) as { count: number };
      expect(graphCheckpointCount.count).toBeGreaterThan(0);
      expect(legacyCheckpointCount.count).toBe(0);
      await first.close?.();

      const second = createProductionDependencies(config, { browserClient: productionBrowserClient() });
      try {
        await second.applicationService!.openBrowser(taskId);
        expect(second.applicationService!.state(taskId).value).toBe("awaiting_login");
      } finally {
        await second.close?.();
      }
    } finally {
      await first.close?.();
      await rm(directory, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fakes.databases.splice(0);
    fakes.migrationFailure = undefined;
  });

  it("composes configured adapters without making startup model requests", () => {
    const fetch = vi.fn();
    const dependencies = createProductionDependencies(fullConfig(), { fetch });

    expect(dependencies.extractPdf).toEqual(expect.any(Function));
    expect(dependencies.extractFacts).toEqual(expect.any(Function));
    expect(dependencies.selfEvaluationModelProvider).toBeDefined();
    expect(dependencies.embeddingSearch).toBeDefined();
    expect(dependencies.adapterHealth).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
    dependencies.close?.();
  });

  it("shares one scheduled embedding provider across ontology resolution and Fact synchronization", async () => {
    let releaseFirstRequest!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const requestSizes: number[] = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const unitVector = [1, ...Array.from({ length: 4_095 }, () => 0)];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      try {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        requestSizes.push(body.input.length);
        if (requestSizes.length === 1) await firstRequest;
        return new Response(JSON.stringify({
          model: "Qwen/Qwen3-Embedding-8B",
          modelRevision: QWEN_REVISION,
          dimensions: 4_096,
          data: body.input.map((_text, index) => ({ index, embedding: unitVector }))
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      } finally {
        activeRequests -= 1;
      }
    });
    const dependencies = createProductionDependencies(loadConfig({
      DATABASE_FILE: ":memory:",
      EMBEDDING_BASE_URL: "http://127.0.0.1:18080",
      EMBEDDING_API_TOKEN: "embedding-test-token",
      EMBEDDING_MODEL: "Qwen/Qwen3-Embedding-8B",
      EMBEDDING_MODEL_REVISION: QWEN_REVISION,
      EMBEDDING_DIMENSIONS: "4096"
    }), { fetch: fetch as typeof globalThis.fetch, browserClient: productionBrowserClient() });
    const profileFact = confirmedProfileFact("basics.name", "候选人事实文本");
    dependencies.profileRepository.createExtracted({ ...profileFact, status: "extracted" });
    dependencies.profileRepository.confirm(profileFact.id);
    const taskId = "7b12f6d4-2935-46d3-ae66-2b75e75a9514";
    dependencies.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });
    const form: FormSnapshot = {
      frameRef: { documentId: fixtureNodeRef.documentId, kind: "main" },
      mutationEpoch: fixtureNodeRef.observedAt,
      id: "snapshot-embedding",
      taskId,
      url: "https://jobs.example.test/apply",
      title: "Application",
      stage: "application_form",
      fields: ["赛事字段甲", "赛事字段乙"].map((label, index) => ({
        nodeRef: { ...fixtureNodeRef, nodeId: `${fixtureNodeRef.nodeId}-${index}` },
        id: `field-${index}`,
        label,
        type: "text" as const,
        required: true,
        options: [],
        currentValue: "",
        sectionHint: "awards" as const,
        semanticHint: "awards[0]"
      })),
      actions: [],
      errors: []
    };

    const applicationRun = dependencies.applicationService!.runUntilPause(taskId, form);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const factSearch = dependencies.embeddingSearch!.search({
      query: "事实查询文本",
      taskId,
      limit: 5
    });
    releaseFirstRequest();

    await expect(Promise.all([applicationRun, factSearch])).resolves.toBeDefined();
    expect(requestSizes.slice(0, 3)).toEqual([32, 32, 22]);
    expect(maximumActiveRequests).toBe(1);
    const trace = dependencies.embeddingTrace.snapshot();
    expect(trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "ontology_build", cacheKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      expect.objectContaining({ operation: "fact_build", cacheKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      expect.objectContaining({ operation: "semantic_resolution", deepSeekUsed: false })
    ]));
    const serializedTrace = JSON.stringify(trace);
    for (const sensitive of [
      "赛事字段甲",
      "赛事字段乙",
      "候选人事实文本",
      "事实查询文本",
      "embedding-test-token"
    ]) {
      expect(serializedTrace).not.toContain(sensitive);
    }
    await dependencies.close?.();
  });

  it("composes an unconfigured degraded app instead of throwing", () => {
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }));

    expect(dependencies.selfEvaluationModelProvider).toBeUndefined();
    expect(dependencies.embeddingSearch).toBeUndefined();
    expect(dependencies.applicationService).toBeDefined();
    expect(dependencies.taskEvents).toBeDefined();
    expect(dependencies.close).toEqual(expect.any(Function));
    dependencies.close?.();
  });

  it("defers an unknown field during the deterministic pass without querying profile RAG", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({ status: "unresolved" as const, reason: "exact_match_not_found" as const }))
    };
    const ragService = { resolveField: vi.fn() };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService,
      profileRepository: { resolveForTask: vi.fn() }
    });

    await expect(resolveField("task-1", applicationField("未知字段"), "deterministic"))
      .resolves.toMatchObject({
        status: "deferred",
        assessment: { status: "unsupported", source: "none", confidence: 0 }
      });
    expect(ragService.resolveField).not.toHaveBeenCalled();
  });

  it.each([
    ["languages", "languages[0]", "languages"],
    ["internship", "work[2]", "work"],
    ["work_combined", "work[1]", "work"]
  ] as const)("maps page section %s into profile semantic context", async (sectionHint, semanticHint, section) => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({ status: "unresolved" as const, reason: "exact_match_not_found" as const }))
    };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService: { resolveField: vi.fn() },
      profileRepository: { resolveForTask: vi.fn() }
    });

    await resolveField("task-1", applicationField("待识别字段", {
      sectionHint,
      semanticHint
    }), "deterministic");

    expect(semanticResolver.resolve).toHaveBeenCalledWith(
      expect.anything(),
      { section, entryContext: semanticHint },
      "deterministic"
    );
  });

  it("keeps a missing project highlight empty instead of asking RAG to invent it", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "mapped" as const,
        semantic: "projects[0].highlights[0]",
        source: "exact_alias" as const,
        confidence: 1
      }))
    };
    const ragService = {
      resolveField: vi.fn(async () => ({
        fieldId: "field-1",
        status: "verified_auto" as const,
        value: "模型生成的项目亮点",
        evidence: [],
        confidence: 1,
        validators: []
      }))
    };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService,
      profileRepository: { resolveForTask: vi.fn(() => undefined) }
    });

    await expect(resolveField("task-1", applicationField("项目亮点", {
      semanticHint: "projects[0].highlights[0]",
      sectionHint: "projects",
      required: false
    }), "deterministic")).resolves.toMatchObject({
      status: "needs_question",
      fieldPath: "projects[0].highlights[0]",
      assessment: { status: "missing", source: "none" }
    });
    expect(ragService.resolveField).not.toHaveBeenCalled();
  });

  it("passes a semantic match into profile RAG using its canonical path", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "mapped" as const,
        semantic: "education[0].enrollmentType",
        source: "embedding" as const,
        confidence: 0.93
      }))
    };
    const ragService = {
      resolveField: vi.fn(async () => ({
        fieldId: "field-1",
        status: "verified_auto" as const,
        value: "统招",
        evidence: [{ documentId: "resume", page: 1, text: "培养方式：统招", extraction: "pdf_text" as const }],
        confidence: 1,
        validators: []
      }))
    };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService,
      profileRepository: {
        resolveForTask: vi.fn(() => confirmedProfileFact("education[0].enrollmentType", "统招"))
      }
    });
    const field = applicationField("培养方式", {
      type: "select",
      options: ["统招", "定向"],
      semanticHint: "education[0]"
    });

    await expect(resolveField("task-1", field, "semantic")).resolves.toMatchObject({
      status: "verified",
      value: "统招",
      fieldPath: "education[0].enrollmentType",
      assessment: {
        semantic: "education[0].enrollmentType",
        status: "ready",
        source: "semantic",
        confidence: 0.93
      }
    });
    expect(ragService.resolveField).toHaveBeenCalledWith(expect.objectContaining({
      semantic: "education[0].enrollmentType",
      fieldId: "field-1"
    }));
  });

  it("resolves a mapped avatar file directly from the profile without sending it to RAG", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "mapped" as const,
        semantic: "basics.avatar",
        source: "exact_alias" as const,
        confidence: 1
      }))
    };
    const avatar = "avatar-0f8fad5b-d9cb-469f-a165-70867728950e.webp";
    const ragService = { resolveField: vi.fn() };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService,
      profileRepository: {
        resolveForTask: vi.fn(() => ({
          id: "avatar-fact", fieldPath: "basics.avatar", value: avatar,
          status: "user_corrected" as const, confidence: 1, scope: "profile" as const,
          evidence: [{ documentId: "user", page: 1, text: "用户上传头像", extraction: "user" as const }], revision: 1
        }))
      }
    });

    await expect(resolveField("task-1", applicationField("个人头像", { type: "file" }), "deterministic"))
      .resolves.toMatchObject({ status: "verified", value: avatar, fieldPath: "basics.avatar" });
    expect(ragService.resolveField).not.toHaveBeenCalled();
  });

  it("resolves truncated native selects by exact profile value instead of a partial option list", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "mapped" as const,
        semantic: "education[0].institution",
        source: "exact_alias" as const,
        confidence: 1
      }))
    };
    const ragService = {
      resolveField: vi.fn(async (_input: { options?: string[]; type?: string }) => ({
        fieldId: "field-1",
        status: "verified_auto" as const,
        value: "Hefei University of Technology",
        evidence: [],
        confidence: 1,
        validators: []
      }))
    };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService,
      profileRepository: {
        resolveForTask: vi.fn(() => confirmedProfileFact(
          "education[0].institution",
          "Hefei University of Technology"
        ))
      }
    });
    const field = applicationField("Which university did you attend?", {
      type: "select",
      controlKind: "native",
      options: ["Aalborg University", "Aalto University"],
      optionsTruncated: true
    });

    await expect(resolveField("task-1", field, "deterministic")).resolves.toMatchObject({
      status: "verified",
      value: "Hefei University of Technology",
      fieldPath: "education[0].institution"
    });
    expect(ragService.resolveField).toHaveBeenCalledWith(expect.objectContaining({
      type: "text",
      semantic: "education[0].institution"
    }));
    expect(ragService.resolveField.mock.calls[0]?.[0]).not.toHaveProperty("options");
  });

  it("validates an empty-option custom search select as profile text", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "mapped" as const,
        semantic: "awards[0].name",
        source: "embedding" as const,
        confidence: 0.96
      }))
    };
    const ragService = {
      resolveField: vi.fn(async (_input: { fieldId: string }) => ({
        fieldId: "field-1",
        status: "verified_auto" as const,
        value: "ACM Competition",
        evidence: [],
        confidence: 1,
        validators: []
      }))
    };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService,
      profileRepository: {
        resolveForTask: vi.fn(() => confirmedProfileFact("awards[0].name", "ACM Competition"))
      }
    });

    await expect(resolveField("task-1", applicationField("Competition name", {
      type: "select",
      options: [],
      controlKind: "custom",
      interactionMode: "search",
      semanticHint: "awards[0]"
    }), "semantic")).resolves.toMatchObject({
      status: "verified",
      value: "ACM Competition",
      fieldPath: "awards[0].name"
    });
    expect(ragService.resolveField).toHaveBeenCalledWith(expect.objectContaining({
      type: "text",
      semantic: "awards[0].name"
    }));
    expect(ragService.resolveField.mock.calls[0]?.[0]).not.toHaveProperty("options");
  });

  it("derives a positive laboratory answer from a confirmed laboratory name", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "mapped" as const,
        semantic: "education[0].hasLaboratory",
        source: "exact_alias" as const,
        confidence: 1
      }))
    };
    const laboratoryFact: ProfileFact = {
      id: "laboratory-fact",
      fieldPath: "education[0].laboratory",
      value: "Robotics Laboratory",
      status: "user_confirmed",
      confidence: 1,
      scope: "profile",
      evidence: [{ documentId: "user", page: 1, text: "Robotics Laboratory", extraction: "user" }],
      revision: 1
    };
    const profileRepository = {
      resolveForTask: vi.fn((_taskId: string, semantic: string) =>
        semantic === "education[0].laboratory" ? laboratoryFact : undefined)
    };
    const ragService = { resolveField: vi.fn() };
    const resolveField = createProductionFieldResolver({ semanticResolver, ragService, profileRepository });

    await expect(resolveField("task-1", applicationField("Has laboratory experience", {
      type: "select",
      options: ["Yes", "No"],
      semanticHint: "education[0].hasLaboratory"
    }), "deterministic")).resolves.toMatchObject({
      status: "verified",
      value: "Yes",
      fieldPath: "education[0].hasLaboratory",
      assessment: { status: "ready", source: "exact" }
    });
    expect(ragService.resolveField).not.toHaveBeenCalled();
  });

  it("derives a negative laboratory answer from an explicit negative profile value", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "mapped" as const,
        semantic: "education[1].hasLaboratory",
        source: "exact_alias" as const,
        confidence: 1
      }))
    };
    const laboratoryFact: ProfileFact = {
      id: "negative-laboratory-fact",
      fieldPath: "education[1].laboratory",
      value: "无",
      status: "user_corrected",
      confidence: 1,
      scope: "profile",
      evidence: [{ documentId: "user", page: 1, text: "无", extraction: "user" }],
      revision: 1
    };
    const profileRepository = {
      resolveForTask: vi.fn((_taskId: string, semantic: string) =>
        semantic === "education[1].laboratory" ? laboratoryFact : undefined)
    };
    const ragService = { resolveField: vi.fn() };
    const resolveField = createProductionFieldResolver({ semanticResolver, ragService, profileRepository });

    await expect(resolveField("task-1", applicationField("是否有实验室经历", {
      type: "select",
      options: ["Yes", "No"],
      semanticHint: "education[1].hasLaboratory"
    }), "deterministic")).resolves.toMatchObject({
      status: "verified",
      value: "No",
      fieldPath: "education[1].hasLaboratory"
    });
    expect(ragService.resolveField).not.toHaveBeenCalled();
  });

  it("projects canonical profile dates into explicit year and month controls", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async (field) => ({
        status: "mapped" as const,
        semantic: field.semanticHint ?? "work[0].startDate",
        source: "exact_alias" as const,
        confidence: 1
      }))
    };
    const ragService = {
      resolveField: vi.fn(async ({ fieldId }: { fieldId: string }) => ({
        fieldId,
        status: "verified_auto" as const,
        value: fieldId === "nonstandard" ? "2026/04" : "2026-04-12",
        evidence: [],
        confidence: 1,
        validators: []
      }))
    };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService,
      profileRepository: {
        resolveForTask: vi.fn((_taskId, fieldPath) => confirmedProfileFact(fieldPath, "2026-04-12"))
      }
    });

    await expect(resolveField("task-1", applicationField("开始时间 年", { id: "year" })))
      .resolves.toMatchObject({ status: "verified", value: "2026" });
    await expect(resolveField("task-1", applicationField("开始时间 月", { id: "month" })))
      .resolves.toMatchObject({ status: "verified", value: "04" });
    await expect(resolveField("task-1", applicationField("结束时间 日", {
      id: "day",
      semanticHint: "work[0].endDate"
    }))).resolves.toMatchObject({ status: "verified", value: "12" });
    await expect(resolveField("task-1", applicationField("出生日期 年", {
      id: "birth-year",
      semanticHint: "basics.birthDate"
    }))).resolves.toMatchObject({ status: "verified", value: "2026" });
    await expect(resolveField("task-1", applicationField("获奖日期 月", {
      id: "award-month",
      semanticHint: "awards[0].date"
    }))).resolves.toMatchObject({ status: "verified", value: "04" });
    await expect(resolveField("task-1", applicationField("开始时间", { id: "full" })))
      .resolves.toMatchObject({ status: "verified", value: "2026-04-12" });
    await expect(resolveField("task-1", applicationField("开始时间 月", { id: "nonstandard" })))
      .resolves.toMatchObject({ status: "verified", value: "2026/04" });
    await expect(resolveField("task-1", applicationField("年份 年", {
      id: "non-date-semantic",
      semanticHint: "work[0].description"
    }))).resolves.toMatchObject({ status: "verified", value: "2026-04-12" });
    await expect(resolveField("task-1", applicationField("开始时间 年份", { id: "approximate-label" })))
      .resolves.toMatchObject({ status: "verified", value: "2026" });
  });

  it("binds a split award month to its entry and returns the page's unpadded option", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "mapped" as const,
        semantic: "awards[0].date",
        source: "embedding" as const,
        confidence: 0.97
      }))
    };
    const ragService = {
      resolveField: vi.fn(async () => ({
        fieldId: "award-month",
        status: "verified_auto" as const,
        value: "2026-04-12",
        evidence: [],
        confidence: 1,
        validators: []
      }))
    };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService,
      profileRepository: {
        resolveForTask: vi.fn(() => confirmedProfileFact("awards[0].date", "2026-04-12"))
      }
    });
    const field = applicationField("起止时间 月", {
      id: "award-month",
      type: "select",
      options: ["3", "4", "5"],
      semanticHint: "awards[0]"
    });

    await expect(resolveField("task-1", field, "semantic")).resolves.toMatchObject({
      status: "verified",
      fieldPath: "awards[0].date",
      value: "4"
    });
    expect(semanticResolver.resolve).toHaveBeenCalledWith(field, {
      section: "awards",
      entryContext: "awards[0]"
    }, "semantic");
  });

  it("validates a full profile date before projecting it into a select option", async () => {
    const fact: ProfileFact = {
      id: "start-date",
      fieldPath: "work[0].startDate",
      value: "2026-04-12",
      status: "user_corrected" as const,
      confidence: 1,
      scope: "profile" as const,
      evidence: [{
        documentId: "user",
        page: 1,
        text: "Corrected value: \"2026-04-12\"",
        extraction: "user" as const
      }],
      revision: 1
    };
    const resolverForFact = (candidate: ProfileFact) => {
      const profileRepository: ProfileRepositoryPort = {
        resolveForTask: () => candidate,
        listActive: () => [candidate],
        putTaskAnswer: () => candidate,
        correct: () => candidate
      };
      return createProductionFieldResolver({
        semanticResolver: {
          resolve: async () => ({
            status: "mapped" as const,
            semantic: candidate.fieldPath,
            source: "exact_alias" as const,
            confidence: 1
          })
        },
        ragService: createRagService({ repository: profileRepository }),
        profileRepository
      });
    };
    const resolveField = resolverForFact(fact);

    await expect(resolveField("task-1", applicationField("开始时间 年", {
      type: "select",
      options: ["2025", "2026"]
    }))).resolves.toMatchObject({
      status: "verified",
      value: "2026",
      assessment: { status: "ready" }
    });
    await expect(resolveField("task-1", applicationField("开始时间 年", {
      type: "select",
      options: ["2025"]
    }))).resolves.toMatchObject({
      status: "blocked",
      assessment: { status: "unsupported" }
    });
    await expect(resolveField("task-1", applicationField("开始时间 年", {
      type: "radio",
      options: ["2025", "2026"]
    }))).resolves.toMatchObject({ status: "verified", value: "2026" });
    await expect(resolveField("task-1", applicationField("开始时间 年", {
      type: "select",
      options: []
    }))).resolves.toMatchObject({ status: "blocked" });
    await expect(resolveField("task-1", applicationField("开始时间 年", {
      type: "select",
      options: [],
      controlKind: "custom"
    }))).resolves.toMatchObject({ status: "verified", value: "2026" });
    await expect(resolverForFact({
      ...fact,
      evidence: [{ ...fact.evidence[0]!, text: "Corrected value: \"2025-04-12\"" }]
    })("task-1", applicationField("开始时间 年", {
      type: "select",
      options: ["2026"]
    }))).resolves.toMatchObject({ status: "blocked" });
    await expect(resolverForFact({ ...fact, status: "superseded" })(
      "task-1",
      applicationField("开始时间 年", { type: "select", options: ["2026"] })
    )).resolves.toMatchObject({ status: "blocked" });
    await expect(resolverForFact({
      ...fact,
      fieldPath: "work[0].description"
    })("task-1", applicationField("工作年份 年", {
      type: "select",
      options: ["2026-04-12"]
    }))).resolves.toMatchObject({ status: "verified", value: "2026-04-12" });
  });

  it("preserves DJI catalog provenance in production field assessments", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "mapped" as const,
        semantic: "education[0].institution",
        source: "exact_alias" as const,
        confidence: 1
      }))
    };
    const ragService = {
      resolveField: vi.fn(async () => ({
        fieldId: "field-1",
        status: "verified_auto" as const,
        value: "Test University",
        evidence: [],
        confidence: 1,
        validators: []
      }))
    };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService,
      profileRepository: {
        resolveForTask: vi.fn(() => confirmedProfileFact("education[0].institution", "Test University"))
      }
    });
    const field = applicationField("School", {
      semanticHint: "education[0].institution",
      semanticSource: "dji_catalog"
    });

    await expect(resolveField("task-1", field, "deterministic")).resolves.toMatchObject({
      assessment: {
        semantic: "education[0].institution",
        status: "ready",
        source: "dji_catalog",
        confidence: 1
      }
    });
  });

  it("persists question answers at their approved paths and consumes them before re-asking", async () => {
    const reviewField = applicationField("专业方向", { id: "field-review" });
    const unknownField = applicationField("未命名字段", { id: "field-unknown" });
    const answers = new Map<string, string>();
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async (field) => field.id === "field-review"
        ? {
            status: "review" as const,
            reason: "similarity_below_threshold" as const,
            candidates: [{
              semantic: "education[0].major",
              label: "专业",
              similarity: 0.89,
              risk: "normal" as const
            }]
          }
        : { status: "unresolved" as const, reason: "embedding_unavailable" as const })
    };
    const ragService = { resolveField: vi.fn() };
    const resolveForTask = vi.fn((_taskId: string, fieldPath: string) => {
      const value = answers.get(fieldPath);
      return value === undefined ? undefined : {
        id: `answer-${fieldPath}`,
        fieldPath,
        value,
        status: "user_confirmed" as const,
        confidence: 1,
        scope: "application" as const,
        taskId: "task-1",
        evidence: [{ documentId: "user", page: 1, text: value, extraction: "user" as const }],
        revision: 1
      };
    });
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService,
      profileRepository: { resolveForTask }
    });
    const reviewQuestion = await resolveField("task-1", reviewField, "semantic");
    const unknownQuestion = await resolveField("task-1", unknownField, "semantic");
    expect(reviewQuestion.status).toBe("needs_question");
    expect(unknownQuestion.status).toBe("needs_question");
    if (!reviewQuestion.fieldPath || !unknownQuestion.fieldPath) throw new Error("question path missing");
    const reviewPath = reviewQuestion.fieldPath;
    const unknownPath = unknownQuestion.fieldPath;
    const questionPaths = [
      { id: reviewField.id, fieldPath: reviewPath },
      { id: unknownField.id, fieldPath: unknownPath }
    ];
    expect(fieldPathForApplicationAnswer(reviewField, questionPaths)).toBe(reviewPath);
    expect(fieldPathForApplicationAnswer(unknownField, questionPaths)).toBe(unknownPath);
    answers.set(reviewPath, "Computer Science");
    answers.set(unknownPath, "Manual answer");

    await expect(resolveField("task-1", reviewField, "semantic")).resolves.toMatchObject({
      status: "verified",
      value: "Computer Science",
      fieldPath: reviewPath,
      assessment: { status: "ready", source: "user", confidence: 1 }
    });
    await expect(resolveField("task-1", unknownField, "semantic")).resolves.toMatchObject({
      status: "verified",
      value: "Manual answer",
      fieldPath: unknownPath,
      assessment: { status: "ready", source: "user", confidence: 1 }
    });
    expect(ragService.resolveField).not.toHaveBeenCalled();
  });

  it("isolates unresolved answers with stable field signatures instead of DOM ids or context-only hints", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({ status: "unresolved" as const, reason: "embedding_unavailable" as const }))
    };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService: { resolveField: vi.fn() },
      profileRepository: { resolveForTask: vi.fn() }
    });
    const first = applicationField("Research direction", { id: "dom-before", semanticHint: "education[0]" });
    const reordered = applicationField("Research direction", { id: "dom-after", semanticHint: "education[0]" });
    const second = applicationField("Advisor name", { id: "dom-other", semanticHint: "education[0]" });

    const [firstDecision, reorderedDecision, secondDecision] = await Promise.all([
      resolveField("task-1", first, "semantic"),
      resolveField("task-1", reordered, "semantic"),
      resolveField("task-1", second, "semantic")
    ]);

    expect(firstDecision).toMatchObject({ status: "needs_question" });
    expect(reorderedDecision).toMatchObject({ status: "needs_question" });
    expect(secondDecision).toMatchObject({ status: "needs_question" });
    expect(firstDecision.fieldPath).toBe(reorderedDecision.fieldPath);
    expect(firstDecision.fieldPath).not.toBe(secondDecision.fieldPath);
    expect(firstDecision.fieldPath).not.toBe("education[0]");
    expect(firstDecision.fieldPath).not.toContain("dom-");
  });

  it("does not let two reviewed fields share the first semantic candidate answer path", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "review" as const,
        reason: "similarity_below_threshold" as const,
        candidates: [{
          semantic: "education[0].major",
          label: "Major",
          similarity: 0.89,
          risk: "normal" as const
        }]
      }))
    };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService: { resolveField: vi.fn() },
      profileRepository: { resolveForTask: vi.fn() }
    });
    const first = await resolveField("task-1", applicationField("Research direction", { id: "field-a" }), "semantic");
    const second = await resolveField("task-1", applicationField("Discipline category", { id: "field-b" }), "semantic");

    expect(first.fieldPath).not.toBe(second.fieldPath);
    expect(first.fieldPath).not.toBe("education[0].major");
    expect(second.fieldPath).not.toBe("education[0].major");
    expect(first.assessment).toMatchObject({ semantic: "education[0].major", confidence: 0 });
    expect(second.assessment).toMatchObject({ semantic: "education[0].major", confidence: 0 });
  });

  it("reports the final value validation confidence instead of a semantic-only full score", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "mapped" as const,
        semantic: "basics.phone",
        source: "exact_alias" as const,
        confidence: 1
      }))
    };
    const missingResolver = createProductionFieldResolver({
      semanticResolver,
      ragService: {
        resolveField: vi.fn(async () => ({
          fieldId: "field-1",
          status: "needs_question" as const,
          evidence: [],
          confidence: 1,
          validators: []
        }))
      },
      profileRepository: { resolveForTask: vi.fn() }
    });
    await expect(missingResolver("task-1", applicationField("Phone"), "deterministic")).resolves.toMatchObject({
      assessment: { status: "missing", confidence: 0 }
    });

    const reviewResolver = createProductionFieldResolver({
      semanticResolver,
      ragService: {
        resolveField: vi.fn(async () => ({
          fieldId: "field-1",
          status: "needs_review" as const,
          value: "13800000000",
          evidence: [],
          confidence: 1,
          validators: []
        }))
      },
      profileRepository: {
        resolveForTask: vi.fn(() => confirmedProfileFact("basics.phone", "13800000000"))
      }
    });
    await expect(reviewResolver("task-1", applicationField("Phone"), "deterministic")).resolves.toMatchObject({
      assessment: { status: "review", confidence: 0.89 }
    });
  });

  it("hands semantic risk decisions to the user without querying or auto-filling profile data", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "review" as const,
        reason: "risk_requires_review" as const,
        candidates: [{
          semantic: "preferences.willingToTravel",
          label: "是否接受出差",
          similarity: 0.96,
          risk: "commitment" as const
        }]
      }))
    };
    const ragService = { resolveField: vi.fn() };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService,
      profileRepository: { resolveForTask: vi.fn() }
    });

    await expect(resolveField("task-1", applicationField("可否长期出差", {
      type: "select",
      options: ["是", "否"]
    }), "semantic")).resolves.toMatchObject({
      status: "needs_question",
      assessment: {
        semantic: "preferences.willingToTravel",
        status: "review",
        source: "semantic",
        confidence: 0
      }
    });
    expect(ragService.resolveField).not.toHaveBeenCalled();
  });

  it("registers the application task API in the production composition", async () => {
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }));
    const app = await createApp(dependencies);

    const response = await app.inject({ method: "GET", url: "/api/applications" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    await app.close();
  });

  it("starts application tasks by opening their target URL before observation", async () => {
    const open = vi.fn(async () => ({
      type: "opened" as const,
      taskId: "unused",
      url: "https://jobs.example.test/apply",
      title: "Jobs"
    }));
    const observe = vi.fn(async (taskId: string) => ({
      type: "snapshot" as const,
      snapshot: {frameRef: { documentId: fixtureNodeRef.documentId, kind: "main" as const }, mutationEpoch: fixtureNodeRef.observedAt, 
        id: "snapshot-login",
        taskId,
        url: "https://jobs.example.test/apply",
        title: "Login",
        stage: "login" as const,
        fields: [], actions: [], errors: []
      }
    }));
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: { open, observe, execute: vi.fn(), stop: vi.fn() }
    });
    const app = await createApp(dependencies);

    const response = await app.inject({
      method: "POST",
      url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/apply" }
    });

    expect(response.statusCode).toBe(201);
    expect(open).toHaveBeenCalledWith(response.json().id, "https://jobs.example.test/apply");
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(observe.mock.invocationCallOrder[0]!);
    await app.close();
  });

  it("lazily forwards browser Worker activity into the application event bus", async () => {
    const activityListeners = new Set<(activity: WorkerActivity) => void>();
    const onActivity = vi.fn((listener: (activity: WorkerActivity) => void) => {
      activityListeners.add(listener);
      return () => activityListeners.delete(listener);
    });
    const browserClient = {
      open: vi.fn(async (taskId: string, url: string) => ({
        type: "opened" as const, taskId, url, title: "Jobs"
      })),
      observe: vi.fn(async (taskId: string) => ({
        type: "snapshot" as const,
        snapshot: {frameRef: { documentId: fixtureNodeRef.documentId, kind: "main" as const }, mutationEpoch: fixtureNodeRef.observedAt, 
          id: "snapshot-login", taskId, url: "https://jobs.example.test/apply",
          title: "Login", stage: "login" as const, fields: [], actions: [], errors: []
        }
      })),
      execute: vi.fn(),
      onActivity,
      stop: vi.fn()
    };
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), { browserClient });
    expect(onActivity).not.toHaveBeenCalled();
    const app = await createApp(dependencies);

    const created = await app.inject({
      method: "POST", url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/apply" }
    });
    const taskId = created.json().id as string;
    expect(onActivity).toHaveBeenCalledOnce();

    for (const listener of activityListeners) {
      listener({ type: "page_changed", taskId });
    }
    await vi.waitFor(() => expect(dependencies.taskEvents?.replayAll(taskId).events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "browser_activity" })])
    ));
    await app.close();
  });

  it("recycles a Worker whose task release fails and transfers activity subscriptions", async () => {
    const firstUnsubscribe = vi.fn();
    const secondUnsubscribe = vi.fn();
    const first = productionBrowserClient({
      releaseTask: vi.fn(async () => { throw new Error("stale worker"); }),
      onActivity: vi.fn(() => firstUnsubscribe)
    });
    const second = productionBrowserClient({
      onActivity: vi.fn(() => secondUnsubscribe)
    });
    const browserClientFactory = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: first,
      browserClientFactory
    });
    const taskId = "4a542b70-4dcc-482e-a282-b3e7478921d8";
    dependencies.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });
    await dependencies.applicationService!.openBrowser(taskId);

    await expect(dependencies.applicationService!.cancel(taskId)).resolves.toBeUndefined();

    expect(first.releaseTask).toHaveBeenCalledWith(taskId);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.releaseTask).not.toHaveBeenCalled();
    expect(browserClientFactory).toHaveBeenCalledTimes(2);
    expect(firstUnsubscribe).toHaveBeenCalledOnce();
    expect(first.onActivity).toHaveBeenCalledOnce();
    expect(second.onActivity).toHaveBeenCalledOnce();
    await dependencies.close?.();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("recycles and retries the first safe open exactly once", async () => {
    const first = productionBrowserClient({
      open: vi.fn(async () => { throw new Error("stale worker"); })
    });
    const second = productionBrowserClient();
    const browserClientFactory = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: first,
      browserClientFactory
    });
    const taskId = "05ef7591-0f36-4795-91b7-e56d76bb680a";
    dependencies.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });

    await expect(dependencies.applicationService!.openBrowser(taskId)).resolves.toBeUndefined();

    expect(first.open).toHaveBeenCalledOnce();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.open).toHaveBeenCalledOnce();
    expect(browserClientFactory).toHaveBeenCalledTimes(2);
    await dependencies.close?.();
  });

  it("does not start a third Worker when the retried open also fails", async () => {
    const first = productionBrowserClient({ open: vi.fn(async () => { throw new Error("first failure"); }) });
    const second = productionBrowserClient({ open: vi.fn(async () => { throw new Error("second failure"); }) });
    const browserClientFactory = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: first,
      browserClientFactory
    });
    const taskId = "f9b5e181-eaf7-457e-a519-cfe22d37f39c";
    dependencies.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });

    await expect(dependencies.applicationService!.openBrowser(taskId)).rejects.toThrow("second failure");

    expect(browserClientFactory).toHaveBeenCalledTimes(2);
    expect(second.open).toHaveBeenCalledOnce();
    await dependencies.close?.();
  });

  it("does not recycle a later open attempt for the same task", async () => {
    const client = productionBrowserClient({
      open: vi.fn()
        .mockResolvedValueOnce({ type: "opened", taskId: "task", url: "https://jobs.example.test/apply", title: "Jobs" })
        .mockRejectedValueOnce(new Error("later open failure"))
    });
    const browserClientFactory = vi.fn().mockResolvedValue(client);
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: client,
      browserClientFactory
    });
    const taskId = "b892741f-739b-4b0a-8970-cb181f42f3b2";
    dependencies.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });
    await dependencies.applicationService!.openBrowser(taskId);

    await expect(dependencies.applicationService!.openBrowser(taskId)).rejects.toThrow("later open failure");

    expect(browserClientFactory).toHaveBeenCalledOnce();
    expect(client.stop).not.toHaveBeenCalled();
    await dependencies.close?.();
  });

  it("does not restore the first-open retry when failed task cleanup is isolated", async () => {
    const first = productionBrowserClient({
      releaseTask: vi.fn(async () => { throw new Error("release failure"); }),
      stop: vi.fn(async () => { throw new Error("stop failure"); })
    });
    const second = productionBrowserClient({
      open: vi.fn(async () => { throw new Error("later open failure"); })
    });
    const third = productionBrowserClient();
    const browserClientFactory = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(third);
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: first,
      browserClientFactory
    });
    const taskId = "ade7d2bd-0b36-4678-b06b-775595c2485a";
    dependencies.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });
    await dependencies.applicationService!.openBrowser(taskId);
    await expect(dependencies.applicationService!.cancel(taskId)).resolves.toBeUndefined();

    await expect(dependencies.applicationService!.openBrowser(taskId)).rejects.toThrow("later open failure");

    expect(browserClientFactory).toHaveBeenCalledTimes(2);
    expect(second.stop).not.toHaveBeenCalled();
    expect(third.open).not.toHaveBeenCalled();
    await dependencies.close?.();
  });

  it("does not start a replacement Worker when close races with recycling", async () => {
    let finishStop: (() => void) | undefined;
    const stopPending = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const first = productionBrowserClient({
      releaseTask: vi.fn(async () => { throw new Error("release failure"); }),
      stop: vi.fn(async () => stopPending)
    });
    const second = productionBrowserClient();
    const browserClientFactory = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: first,
      browserClientFactory
    });
    const taskId = "c00ea867-c851-431e-a544-ec20ba4e5461";
    dependencies.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });
    await dependencies.applicationService!.openBrowser(taskId);
    const cancellation = dependencies.applicationService!.cancel(taskId).catch((error: unknown) => error);
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalledOnce());

    const closing = dependencies.close?.();
    finishStop?.();
    await closing;
    await cancellation;

    expect(first.stop).toHaveBeenCalledOnce();
    expect(browserClientFactory).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();
  });

  it("does not recycle a Worker after an observation failure", async () => {
    const first = productionBrowserClient({
      observe: vi.fn(async () => { throw new Error("observation failure"); })
    });
    const browserClientFactory = vi.fn().mockResolvedValue(first);
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: first,
      browserClientFactory
    });
    const taskId = "3e05c1be-b83e-47a1-a8f5-8243de55383d";
    dependencies.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });
    await dependencies.applicationService!.openBrowser(taskId);

    await expect(dependencies.applicationService!.runUntilPause(taskId)).rejects.toThrow("observation failure");

    expect(browserClientFactory).toHaveBeenCalledOnce();
    expect(first.stop).not.toHaveBeenCalled();
    await dependencies.close?.();
  });

  it("does not retain a failed Worker startup promise", async () => {
    const client = productionBrowserClient();
    const browserClientFactory = vi.fn()
      .mockRejectedValueOnce(new Error("startup failure"))
      .mockResolvedValueOnce(client);
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: client,
      browserClientFactory
    });
    const taskId = "a03ed3e4-b948-4f96-aa42-13fbf36603f6";
    dependencies.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });

    await expect(dependencies.applicationService!.openBrowser(taskId)).rejects.toThrow("startup failure");
    await expect(dependencies.applicationService!.openBrowser(taskId)).resolves.toBeUndefined();

    expect(browserClientFactory).toHaveBeenCalledTimes(2);
    expect(client.open).toHaveBeenCalledOnce();
    await dependencies.close?.();
  });

  it("does not consume the first-open retry when Worker startup fails before navigation", async () => {
    const failedOpen = productionBrowserClient({
      open: vi.fn(async () => { throw new Error("stale after startup"); })
    });
    const recovered = productionBrowserClient();
    const browserClientFactory = vi.fn()
      .mockRejectedValueOnce(new Error("startup failure"))
      .mockResolvedValueOnce(failedOpen)
      .mockResolvedValueOnce(recovered);
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: failedOpen,
      browserClientFactory
    });
    const taskId = "2cc3f67d-2d38-45c2-8645-f20121621f6a";
    dependencies.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });

    await expect(dependencies.applicationService!.openBrowser(taskId)).rejects.toThrow("startup failure");
    await expect(dependencies.applicationService!.openBrowser(taskId)).resolves.toBeUndefined();

    expect(browserClientFactory).toHaveBeenCalledTimes(3);
    expect(failedOpen.open).toHaveBeenCalledOnce();
    expect(recovered.open).toHaveBeenCalledOnce();
    await dependencies.close?.();
  });

  it("does not recycle or replay a failed execute command", async () => {
    const client = productionBrowserClient({
      execute: vi.fn(async () => { throw new Error("execution failure"); })
    });
    const browserClientFactory = vi.fn().mockResolvedValue(client);
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), {
      browserClient: client,
      browserClientFactory
    });
    dependencies.profileRepository.createExtracted({
      id: "self-evaluation",
      fieldPath: "selfEvaluation",
      value: "原始自我评价",
      status: "extracted",
      confidence: 1,
      scope: "profile",
      evidence: [{ documentId: "resume", page: 1, text: "原始自我评价", extraction: "pdf_text" }],
      revision: 1
    });
    dependencies.profileRepository.confirm("self-evaluation");
    const taskId = "ac278692-dcf5-4682-8581-50d344023f5a";
    dependencies.applicationService!.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });
    const form: FormSnapshot = {frameRef: { documentId: fixtureNodeRef.documentId, kind: "main" as const }, mutationEpoch: fixtureNodeRef.observedAt, 
      id: "snapshot-form",
      taskId,
      url: "https://jobs.example.test/apply",
      title: "Application",
      stage: "application_form",
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "self",
        label: "自我评价",
        type: "textarea",
        required: true,
        options: [],
        currentValue: "",
        semanticHint: "selfEvaluation"
      }],
      actions: [],
      errors: []
    };

    await dependencies.applicationService!.runUntilPause(taskId, form);
    const review = dependencies.applicationService!.contentReview(taskId);
    if (!review) throw new Error("content review missing");
    await expect(dependencies.applicationService!.approveReview(taskId, review.id)).resolves.toBeUndefined();
    await expect(dependencies.applicationService!.runUntilPause(taskId, form)).resolves.toBeUndefined();

    expect(client.execute).toHaveBeenCalledOnce();
    expect(browserClientFactory).toHaveBeenCalledOnce();
    expect(client.stop).not.toHaveBeenCalled();
    expect(dependencies.applicationService!.progress(taskId).status).toBe("paused");
    await dependencies.close?.();
  });

  it("reviews a profile self-evaluation once and fills the approved task value", async () => {
    const executedValues: unknown[] = [];
    const formFor = (taskId: string, id: string, value = ""): FormSnapshot => ({frameRef: { documentId: fixtureNodeRef.documentId, kind: "main" as const }, mutationEpoch: fixtureNodeRef.observedAt, 
      id,
      taskId,
      url: "https://jobs.example.test/apply",
      title: "Application",
      stage: "application_form" as const,
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "self",
        label: "自我评价",
        type: "textarea" as const,
        required: true,
        options: [],
        currentValue: value,
        semanticHint: "selfEvaluation"
      }],
      actions: [{ nodeRef: fixtureNodeRef, id: "next", text: "下一步", class: "intermediate_navigation" as const }],
      errors: []
    });
    let taskId = "";
    let snapshot = formFor("placeholder", "form-1");
    const browserClient = {
      open: vi.fn(async (id: string) => {
        taskId = id;
        snapshot = formFor(id, "form-1");
        return { type: "opened" as const, taskId: id, url: snapshot.url, title: snapshot.title };
      }),
      observe: vi.fn(async () => ({ type: "snapshot" as const, snapshot })),
      execute: vi.fn(async (command: { type: string; taskId: string; value?: unknown }) => {
        if (command.type === "fill") {
          executedValues.push(command.value);
          snapshot = formFor(command.taskId, "form-filled", String(command.value));
        } else {
          snapshot = {
            ...formFor(command.taskId, "review"),
            stage: "review" as const,
            fields: [],
            actions: [{ nodeRef: fixtureNodeRef, id: "submit", text: "提交申请", class: "terminal_submit" as const }]
          };
        }
        return {
          type: "execution_result" as const,
          taskId: command.taskId,
          snapshotId: snapshot.id,
          commandType: command.type as "fill" | "click_intermediate",
          status: "applied" as const,
          actualValue: command.value ?? snapshot.url,
          snapshot,
          errors: []
        };
      }),
      stop: vi.fn()
    };
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }), { browserClient });
    dependencies.profileRepository.createExtracted({
      id: "self-profile",
      fieldPath: "selfEvaluation",
      value: "原始自我评价",
      status: "extracted",
      confidence: 1,
      scope: "profile",
      evidence: [{ documentId: "resume", page: 1, text: "原始自我评价", extraction: "pdf_text" }],
      revision: 1
    });
    dependencies.profileRepository.confirm("self-profile");
    const app = await createApp(dependencies);

    const created = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: snapshot.url }
    });
    expect(created.json()).toMatchObject({
      id: taskId,
      state: "awaiting_content_review",
      contentReview: { draft: "原始自我评价" }
    });

    const unsupported = await app.inject({
      method: "POST",
      url: `/api/applications/${taskId}/commands`,
      payload: {
        type: "approve_content",
        reviewId: created.json().contentReview.id,
        editedValue: "针对岗位修订后的自我评价"
      }
    });
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json()).toMatchObject({ code: "content_review_unsupported_edit" });
    expect(executedValues).toEqual([]);

    const approved = await app.inject({
      method: "POST",
      url: `/api/applications/${taskId}/commands`,
      payload: {
        type: "approve_content",
        reviewId: created.json().contentReview.id
      }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ state: "review_locked", commands: [] });
    expect(executedValues).toEqual(["原始自我评价"]);
    await app.close();
  });

  it("closes the owned database exactly once when migration fails", () => {
    const failure = new Error("migration failed");
    fakes.migrationFailure = failure;

    expect(() => createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }))).toThrow(failure);
    expect(fakes.databases[0]?.closeCalls).toBe(1);
  });

  it("closes the owned database once across repeated direct and app close paths", async () => {
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }));
    const app = await createApp(dependencies);

    await dependencies.close?.();
    await dependencies.close?.();
    await app.close();

    expect(fakes.databases[0]?.closeCalls).toBe(1);
  });
});

function applicationField(
  label: string,
  overrides: Partial<FormField> = {}
): FormField {
  return {nodeRef: fixtureNodeRef, 
    id: "field-1",
    label,
    type: "text",
    required: true,
    options: [],
    currentValue: "",
    ...overrides
  };
}

function confirmedProfileFact(fieldPath: string, value: ProfileFact["value"]): ProfileFact {
  return {
    id: `fact-${fieldPath}`,
    fieldPath,
    value,
    status: "user_confirmed",
    confidence: 1,
    scope: "profile",
    evidence: [{
      documentId: "user",
      page: 1,
      text: typeof value === "string" ? value : JSON.stringify(value),
      extraction: "user"
    }],
    revision: 1
  };
}

function productionBrowserClient(overrides: Record<string, unknown> = {}) {
  const jobSnapshot = (ownerId: string): JobPageSnapshot => ({
    id: `job-snapshot-${ownerId}`,
    ownerId,
    url: "https://acme.mokahr.com/jobs",
    title: "Jobs",
    capturedAt: "2026-08-16T00:00:00.000Z",
    entryHint: "job_list",
    visibleText: [],
    jobCards: [],
    filterState: [],
    pagination: { kind: "none", hasNext: false },
    boundaries: []
  });
  return {
    open: vi.fn(async (taskId: string, url: string) => ({ type: "opened" as const, taskId, url, title: "Jobs" })),
    openPublic: vi.fn(async (taskId: string, url: string) => ({ type: "opened" as const, taskId, url, title: "Jobs" })),
    observe: vi.fn(async (taskId: string) => ({
      type: "snapshot" as const,
      snapshot: {frameRef: { documentId: fixtureNodeRef.documentId, kind: "main" as const }, mutationEpoch: fixtureNodeRef.observedAt, 
        id: `snapshot-${taskId}`,
        taskId,
        url: "https://jobs.example.test/apply",
        title: "Login",
        stage: "login" as const,
        fields: [], actions: [], errors: []
      }
    })),
    execute: vi.fn(),
    observeJob: vi.fn(async (ownerId: string) => jobSnapshot(ownerId)),
    applyJobFilters: vi.fn(async (ownerId: string) => jobSnapshot(ownerId)),
    advanceJobPage: vi.fn(async (ownerId: string) => jobSnapshot(ownerId)),
    invalidateExecution: vi.fn(async () => undefined),
    releaseTask: vi.fn(async () => undefined),
    onActivity: vi.fn(() => vi.fn()),
    stop: vi.fn(async () => undefined),
    ...overrides
  };
}
