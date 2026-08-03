import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { FormField, FormSnapshot, WorkerActivity } from "@resume/contracts";
import type { FieldSemanticResolver } from "./applications/field-semantic-resolver.js";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

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

const { createProductionDependencies, createProductionFieldResolver } = await import("./production-dependencies.js");

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
      .resolves.toEqual({ status: "deferred" });
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
        evidence: [],
        confidence: 1,
        validators: []
      }))
    };
    const resolveField = createProductionFieldResolver({
      semanticResolver,
      ragService,
      profileRepository: { resolveForTask: vi.fn() }
    });
    const field = applicationField("培养方式", {
      type: "select",
      options: ["统招", "定向"],
      semanticHint: "education[0]"
    });

    await expect(resolveField("task-1", field, "semantic")).resolves.toMatchObject({
      status: "verified",
      value: "统招",
      fieldPath: "education[0].enrollmentType"
    });
    expect(ragService.resolveField).toHaveBeenCalledWith(expect.objectContaining({
      semantic: "education[0].enrollmentType",
      fieldId: "field-1"
    }));
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
      fieldPath: "preferences.willingToTravel"
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
      snapshot: {
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
        snapshot: {
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

  it("reviews a profile self-evaluation once and fills the approved task value", async () => {
    const executedValues: unknown[] = [];
    const formFor = (taskId: string, id: string, value = ""): FormSnapshot => ({
      id,
      taskId,
      url: "https://jobs.example.test/apply",
      title: "Application",
      stage: "application_form" as const,
      fields: [{
        id: "self",
        label: "自我评价",
        type: "textarea" as const,
        required: true,
        options: [],
        currentValue: value,
        semanticHint: "selfEvaluation"
      }],
      actions: [{ id: "next", text: "下一步", class: "intermediate_navigation" as const }],
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
            actions: [{ id: "submit", text: "提交申请", class: "terminal_submit" as const }]
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
  return {
    id: "field-1",
    label,
    type: "text",
    required: true,
    options: [],
    currentValue: "",
    ...overrides
  };
}
