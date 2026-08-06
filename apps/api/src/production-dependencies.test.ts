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
      .resolves.toMatchObject({
        status: "deferred",
        assessment: { status: "unsupported", source: "none", confidence: 0 }
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

  it("projects canonical profile dates into explicit year and month controls", async () => {
    const semanticResolver: FieldSemanticResolver = {
      resolve: vi.fn(async () => ({
        status: "mapped" as const,
        semantic: "work[0].startDate",
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
      profileRepository: { resolveForTask: vi.fn() }
    });

    await expect(resolveField("task-1", applicationField("开始时间 年", { id: "year" })))
      .resolves.toMatchObject({ status: "verified", value: "2026" });
    await expect(resolveField("task-1", applicationField("开始时间 月", { id: "month" })))
      .resolves.toMatchObject({ status: "verified", value: "04" });
    await expect(resolveField("task-1", applicationField("开始时间", { id: "full" })))
      .resolves.toMatchObject({ status: "verified", value: "2026-04-12" });
    await expect(resolveField("task-1", applicationField("开始时间 月", { id: "nonstandard" })))
      .resolves.toMatchObject({ status: "verified", value: "2026/04" });
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
      profileRepository: { resolveForTask: vi.fn() }
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
      profileRepository: { resolveForTask: vi.fn() }
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
