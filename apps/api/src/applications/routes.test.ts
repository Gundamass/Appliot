import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { migrateDatabase } from "../db/migrate.js";
import { createAdapterHealthRegistry } from "../health/adapter-health.js";
import { createLocalOriginalDocumentStore } from "../profile/original-document-store.js";
import { createProfileRepository } from "../profile/profile-repository.js";
import { createApplicationService } from "./application-service.js";
import { createApplicationTaskRepository } from "./application-task-repository.js";
import { createCheckpointRepository } from "./checkpoint-repository.js";
import { createTaskEventBus } from "./task-events.js";
const fixtureNodeRef = {
  documentId: "document-fixture-00000001",
  nodeId: "node-fixture-000000000001",
  observedAt: 7
};



const resources: Array<{ app: Awaited<ReturnType<typeof createApp>>; database: InstanceType<typeof Database>; storageRoot: string }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    await resource.app.close();
    resource.database.close();
    await rm(resource.storageRoot, { recursive: true, force: true });
  }
});

async function buildApp(options: {
  sseHeartbeatMs?: number;
  observeStages?: Array<"login" | "application_form" | "review">;
  challengeFirstObservation?: boolean;
  invalidateExecution?: (taskId: string, executionEpoch: number) => Promise<void>;
  releaseTask?: (taskId: string) => Promise<void>;
} = {}) {
  const database = new Database(":memory:");
  migrateDatabase(database);
  const storageRoot = await mkdtemp(join(tmpdir(), "resume-application-routes-"));
  const profileRepository = createProfileRepository(database);
  const open = vi.fn(async () => ({ type: "opened" as const }));
  const stages = [...(options.observeStages ?? ["login"] as const)];
  let observed = 0;
  const applicationService = createApplicationService({
    checkpoints: createCheckpointRepository(database),
    browser: {
      open,
      ...(options.invalidateExecution === undefined ? {} : { invalidateExecution: options.invalidateExecution }),
      ...(options.releaseTask === undefined ? {} : { releaseTask: options.releaseTask }),
      async observe(taskId) {
        const stage = stages[Math.min(observed++, stages.length - 1)] ?? "login";
        return {frameRef: { documentId: fixtureNodeRef.documentId, kind: "main" as const }, mutationEpoch: fixtureNodeRef.observedAt,
          id: `snapshot-${taskId}-${observed}`,
          taskId,
          url: "https://jobs.example.test/apply",
          title: stage === "login" ? "Login" : "Application",
          stage,
          fields: [],
          actions: [],
          errors: [],
          ...(options.challengeFirstObservation === true && observed === 1 ? {
            boundaries: [],
            challenge: {
              kind: "captcha" as const,
              detectedAt: "2026-08-15T00:00:00.000Z",
              reasonCode: "moka_captcha_accessible_name"
            }
          } : {})
        };
      },
      async execute(command) {
        const snapshot = await this.observe(command.taskId);
        return {
          type: "execution_result" as const,
          taskId: command.taskId,
          snapshotId: snapshot.id,
          commandType: command.type,
          status: "applied" as const,
          actualValue: command.type === "fill" ? command.value : "",
          snapshot,
          errors: []
        };
      }
    },
    resolveField: async () => ({ status: "verified" as const, value: "" }),
    approve: () => "not-used"
  });
  const eventBus = createTaskEventBus(database);
  const app = await createApp({
    database,
    adapterHealth: createAdapterHealthRegistry(),
    profileRepository,
    originalDocumentStore: createLocalOriginalDocumentStore(storageRoot),
    extractPdf: async (bytes) => ({
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
      pages: []
    }),
    extractFacts: async () => [],
    applicationService,
    taskEvents: eventBus,
    ...(options.sseHeartbeatMs === undefined ? {} : { applicationSseHeartbeatMs: options.sseHeartbeatMs })
  });
  resources.push({ app, database, storageRoot });
  return { app, eventBus, profileRepository, database, storageRoot, open, applicationService };
}

async function buildQuestionApp() {
  const database = new Database(":memory:");
  migrateDatabase(database);
  const storageRoot = await mkdtemp(join(tmpdir(), "resume-application-question-routes-"));
  const profileRepository = createProfileRepository(database);
  const applicationService = createApplicationService({
    checkpoints: createCheckpointRepository(database),
    browser: {
      async open() { return { type: "opened" as const }; },
      async observe(taskId) {
        return {frameRef: { documentId: fixtureNodeRef.documentId, kind: "main" as const }, mutationEpoch: fixtureNodeRef.observedAt, 
          id: `snapshot-${taskId}`,
          taskId,
          url: "https://jobs.example.test/apply",
          title: "Application",
          stage: "application_form" as const,
          fields: [{ nodeRef: fixtureNodeRef, 
            id: "city",
            label: "城市",
            type: "text" as const,
            required: true,
            options: [],
            currentValue: "",
            semanticHint: "preferences.city"
          }],
          actions: [],
          errors: []
        };
      },
      async execute(command) {
        const snapshot = await this.observe(command.taskId);
        return {
          type: "execution_result" as const,
          taskId: command.taskId,
          snapshotId: snapshot.id,
          commandType: command.type,
          status: "applied" as const,
          actualValue: command.type === "fill" ? command.value : "",
          snapshot,
          errors: []
        };
      }
    },
    resolveField: async (taskId) => {
      const answer = profileRepository.resolveForTask(taskId, "preferences.city");
      return answer
        ? { status: "verified" as const, value: answer.value }
        : { status: "needs_question" as const, question: "请选择城市" };
    },
    approve: () => "unused",
    applyAnswers: async (taskId, answers, fields) => {
      const field = fields.find((candidate) => candidate.id === "city");
      if (!field) throw new Error("field missing");
      profileRepository.putTaskAnswer(taskId, field.semanticHint!, answers.city as string, [{
        documentId: "user", page: 1, text: String(answers.city), extraction: "user"
      }]);
    }
  });
  const app = await createApp({
    database,
    adapterHealth: createAdapterHealthRegistry(),
    profileRepository,
    originalDocumentStore: createLocalOriginalDocumentStore(storageRoot),
    extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }),
    extractFacts: async () => [],
    applicationService,
    taskEvents: createTaskEventBus(database)
  });
  resources.push({ app, database, storageRoot });
  return { app, profileRepository };
}

async function buildContentReviewApp(reviewStatus: "needs_review" | "blocked" | "inconsistent" = "needs_review") {
  const database = new Database(":memory:");
  migrateDatabase(database);
  const storageRoot = await mkdtemp(join(tmpdir(), "resume-application-review-routes-"));
  const profileRepository = createProfileRepository(database);
  const page = {frameRef: { documentId: fixtureNodeRef.documentId, kind: "main" as const }, mutationEpoch: fixtureNodeRef.observedAt, 
    id: "snapshot-review-source",
    taskId: "placeholder",
    url: "https://jobs.example.test/apply",
    title: "填写申请",
    stage: "application_form" as const,
    fields: [{ nodeRef: fixtureNodeRef, id: "self", label: "自我评价", type: "textarea" as const, required: true, options: [], currentValue: "" }],
    actions: [{ nodeRef: fixtureNodeRef, id: "next", text: "下一步", class: "intermediate_navigation" as const }],
    errors: []
  };
  const executedValues: unknown[] = [];
  const service = createApplicationService({
    checkpoints: createCheckpointRepository(database),
    browser: {
      async open() { return { type: "opened" as const }; },
      async observe(taskId) { return { ...page, taskId }; },
      async execute(command) {
        if (command.type === "fill") executedValues.push(command.value);
        const review = command.type === "click_intermediate";
        const snapshot = review
          ? { ...page, id: "snapshot-review", taskId: command.taskId, stage: "review" as const, fields: [], actions: [] }
          : { ...page, id: "snapshot-filled", taskId: command.taskId };
        return {
          type: "execution_result" as const,
          taskId: command.taskId,
          snapshotId: snapshot.id,
          commandType: command.type,
          status: "applied" as const,
          actualValue: command.type === "fill" ? command.value : snapshot.url,
          snapshot,
          errors: []
        };
      }
    },
    resolveField: async (taskId) => {
      const approved = profileRepository.resolveForTask(taskId, "selfEvaluation");
      return approved
        ? { status: "verified" as const, value: approved.value }
        : {
            status: "verified" as const,
            value: "岗位微调草稿",
            requiresContentReview: true,
            contentReview: {
              original: "原始自我评价",
              reasons: ["突出已验证的后端项目经验"],
              evidence: [{ documentId: "resume", page: 1, text: "负责 Java 后端开发", extraction: "pdf_text" as const }],
              unsupportedClaims: reviewStatus === "needs_review" ? [] : ["新增了未验证的 Rust 经验"],
              status: reviewStatus === "blocked" ? "blocked" as const : "needs_review" as const
            }
          };
    },
    approve: () => "unused",
    applyAnswers: async (taskId, answers) => {
      profileRepository.putTaskAnswer(taskId, "selfEvaluation", answers.self as string, [{
        documentId: "user", page: 1, text: String(answers.self), extraction: "user"
      }]);
    },
    validateContentReview: () => []
  });
  const eventBus = createTaskEventBus(database);
  const app = await createApp({
    database,
    adapterHealth: createAdapterHealthRegistry(),
    profileRepository,
    originalDocumentStore: createLocalOriginalDocumentStore(storageRoot),
    extractPdf: async (bytes) => ({ fingerprint: createHash("sha256").update(bytes).digest("hex"), pages: [] }),
    extractFacts: async () => [],
    applicationService: service,
    taskEvents: eventBus
  });
  resources.push({ app, database, storageRoot });
  return { app, database, profileRepository, executedValues };
}

describe("application task routes", () => {
  it("creates a task, persists its explicit name, emits replayable state changes, and never exposes a submit command", async () => {
    const { app, database, eventBus } = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/applications",
      payload: { name: "大疆后端岗位", applicationUrl: "https://jobs.example.test/apply" }
    });

    expect(response.statusCode).toBe(201);
    const task = response.json();
    expect(task).toMatchObject({
      id: expect.any(String),
      name: "大疆后端岗位",
      commands: expect.not.arrayContaining(["submit"]),
      executionProgress: {
        currentPhase: "waiting_for_form",
        current: { action: "等待进入简历填写页", maxAttempts: 2 }
      }
    });
    expect(database.prepare("SELECT name FROM application_tasks WHERE id = ?").get(task.id)).toEqual({
      name: "大疆后端岗位"
    });
    expect(eventBus.history(task.id).map((event) => event.state)).toContain("waiting_for_login");

    expect(eventBus.history(task.id, eventBus.history(task.id)[0]!.id))
      .toEqual([eventBus.history(task.id)[1]]);
  });

  it("suggests and persists a name when an older client only sends the application URL", async () => {
    const { app, database } = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/applications",
      payload: { applicationUrl: "https://apply.careers.dji.com/campus-recruitment/dji/143359" }
    });

    expect(response.statusCode).toBe(201);
    const task = response.json();
    expect(task.name).toBe("大疆校招投递");
    expect(database.prepare("SELECT name FROM application_tasks WHERE id = ?").get(task.id)).toEqual({
      name: "大疆校招投递"
    });
  });

  it("keeps SSE open for replay, future events, heartbeats, and cleans up on disconnect", async () => {
    const { app, eventBus } = await buildApp({ sseHeartbeatMs: 20 });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = await app.inject({
      method: "POST",
      url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/apply" }
    });
    const taskId = created.json().id as string;
    const firstId = eventBus.history(taskId)[0]!.id;
    const abort = new AbortController();
    const response = await fetch(`${address}/api/applications/${taskId}/events`, {
      headers: { "Last-Event-ID": firstId },
      signal: abort.signal
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const replay = await readUntil(reader, (text) => text.includes("event: state_changed"));
    expect(replay).not.toContain(`id: ${firstId}\n`);

    const future = eventBus.emit(taskId, "failed");
    const futureFrame = await readUntil(reader, (text) => text.includes(`id: ${future.id}\n`));
    expect(futureFrame).toContain(`"state":"failed"`);
    expect(await readUntil(reader, (text) => text.includes(": heartbeat"))).toContain(": heartbeat");

    abort.abort();
    await reader.cancel().catch(() => undefined);
    await waitFor(() => eventBus.subscriberCount(taskId) === 0);
    expect(eventBus.subscriberCount(taskId)).toBe(0);
  });

  it("does not duplicate an event emitted while replay history is being read", async () => {
    const { app, eventBus } = await buildApp({ sseHeartbeatMs: 20 });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = await app.inject({
      method: "POST",
      url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/apply" }
    });
    const taskId = created.json().id as string;
    const originalReplay = eventBus.replay.bind(eventBus);
    let boundaryEventId = "";
    let triggerBoundaryEvent = true;
    eventBus.replay = (requestedTaskId, afterId) => {
      if (triggerBoundaryEvent) {
        triggerBoundaryEvent = false;
        boundaryEventId = eventBus.emit(taskId, "failed").id;
      }
      return originalReplay(requestedTaskId, afterId);
    };
    const abort = new AbortController();
    const response = await fetch(`${address}/api/applications/${taskId}/events`, { signal: abort.signal });
    const reader = response.body!.getReader();
    try {
      const streamed = await readUntil(reader, (text) => text.includes(": heartbeat"));

      expect(streamed.match(new RegExp(`id: ${boundaryEventId}\\n`, "g"))).toHaveLength(1);
    } finally {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it("rejects malformed and unknown commands without making a submit command representable", async () => {
    const { app } = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/apply" }
    });

    const malformed = await app.inject({
      method: "POST",
      url: `/api/applications/${created.json().id}/commands`,
      payload: { type: "submit" }
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "invalid_application_command" });
    const missing = await app.inject({
      method: "POST",
      url: "/api/applications/00000000-0000-4000-8000-000000000000/commands",
      payload: { type: "cancel" }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "application_task_not_found" });
  });

  it("rejects commands that are not exposed for the current state", async () => {
    const { app } = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/apply" }
    });
    expect(created.json().commands).not.toContain("approve_content");

    const response = await app.inject({
      method: "POST",
      url: `/api/applications/${created.json().id}/commands`,
      payload: { type: "approve_content", reviewId: "forged" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "application_command_not_allowed" });
  });

  it("exposes resume only while a task is waiting for login", async () => {
    const { app, database, applicationService } = await buildApp();
    const task = {
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      applicationUrl: "https://jobs.example.test/observing"
    };
    applicationService.start({ taskId: task.id, applicationUrl: task.applicationUrl });
    createApplicationTaskRepository(database).create(task);

    const observing = await app.inject({ method: "GET", url: `/api/applications/${task.id}` });

    expect(observing.json()).toMatchObject({
      state: "observing_page",
      commands: ["cancel", "open_browser"]
    });
  });

  it("exposes the sanitized adapter review and resumes only through certification", async () => {
    const { app, database, applicationService } = await buildApp();
    const stored = {
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      applicationUrl: "https://jobs.example.test/adapter-review"
    };
    applicationService.start({ taskId: stored.id, applicationUrl: stored.applicationUrl });
    createApplicationTaskRepository(database).create(stored);
    vi.spyOn(applicationService, "state").mockReturnValue({
      value: "awaiting_adapter_review",
      context: { taskId: stored.id, applicationUrl: stored.applicationUrl, questions: [], errors: [] }
    } as unknown as ReturnType<typeof applicationService.state>);
    vi.spyOn(applicationService, "requiresRecovery").mockReturnValue(true);
    const adapterReview = {
      replayReports: [],
      lifecycleStatus: "candidate" as const,
      aiReviewUnavailable: false,
      writeBlocked: true as const
    };
    vi.spyOn(applicationService, "adapterReview").mockReturnValue(adapterReview);
    const resumeAfterCertification = vi.spyOn(applicationService, "resumeAfterAdapterCertification").mockResolvedValue();

    const response = await app.inject({ method: "GET", url: `/api/applications/${stored.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "awaiting_adapter_review",
      commands: ["cancel", "open_browser", "resume_after_adapter_certification"],
      adapterReview
    });
    const resume = await app.inject({
      method: "POST",
      url: `/api/applications/${stored.id}/commands`,
      payload: { type: "resume_after_adapter_certification" }
    });
    expect(resume.statusCode).toBe(200);
    expect(resumeAfterCertification).toHaveBeenCalledWith(stored.id);
  });

  it("projects the recovery commands currently authorized by the coordinator", async () => {
    const { app, database, applicationService } = await buildApp();
    const stored = {
      id: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      applicationUrl: "https://jobs.example.test/paused"
    };
    applicationService.start({ taskId: stored.id, applicationUrl: stored.applicationUrl });
    createApplicationTaskRepository(database).create(stored);
    vi.spyOn(applicationService, "recoveryCommands").mockReturnValue(["manual_done"]);

    const response = await app.inject({ method: "GET", url: `/api/applications/${stored.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().recoveryCommands).toEqual(["manual_done"]);
  });

  it("promotes only the named task answer to a profile default", async () => {
    const { app, profileRepository } = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/apply" }
    });
    const taskId = created.json().id as string;
    const answer = profileRepository.putTaskAnswer(taskId, "basics.city", "Hangzhou", [{
      documentId: "user",
      page: 1,
      text: "Provided for this application",
      extraction: "user"
    }]);

    const response = await app.inject({
      method: "POST",
      url: `/api/applications/${taskId}/commands`,
      payload: { type: "promote_answer_to_profile", answerId: answer.id }
    });

    expect(response.statusCode).toBe(200);
    expect(profileRepository.listActive()).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: "basics.city", value: "Hangzhou", scope: "profile" })
    ]));
  });

  it("returns the scoped review id and persists an approved edited value", async () => {
    const { app, profileRepository, executedValues } = await buildContentReviewApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/apply" }
    });
    const task = created.json();
    expect(task).toMatchObject({
      state: "awaiting_content_review",
      commands: expect.arrayContaining(["approve_content", "reject_content"]),
      contentReview: {
        id: expect.any(String),
        fieldId: "self",
        fieldLabel: "自我评价",
        original: "原始自我评价",
        draft: "岗位微调草稿",
        reasons: ["突出已验证的后端项目经验"],
        evidence: [{ documentId: "resume", page: 1, text: "负责 Java 后端开发", extraction: "pdf_text" }],
        unsupportedClaims: [],
        status: "needs_review"
      }
    });

    const forged = await app.inject({
      method: "POST",
      url: `/api/applications/${task.id}/commands`,
      payload: { type: "approve_content", reviewId: "forged", editedValue: "伪造编辑" }
    });
    expect(forged.statusCode).toBe(409);
    expect(forged.json()).toMatchObject({ code: "content_review_mismatch" });

    const approved = await app.inject({
      method: "POST",
      url: `/api/applications/${task.id}/commands`,
      payload: { type: "approve_content", reviewId: task.contentReview.id, editedValue: "用户确认后的自我评价" }
    });
    expect(approved.statusCode).toBe(200);
    expect(profileRepository.resolveForTask(task.id, "selfEvaluation")?.value)
      .toBe("用户确认后的自我评价");
    expect(executedValues).toContain("用户确认后的自我评价");
  });

  it("removes approval commands from a blocked content review", async () => {
    const { app } = await buildContentReviewApp("blocked");
    const created = await app.inject({
      method: "POST",
      url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/apply" }
    });

    expect(created.json()).toMatchObject({
      state: "awaiting_content_review",
      commands: ["cancel", "open_browser", "reject_content"],
      contentReview: { status: "blocked", unsupportedClaims: ["新增了未验证的 Rust 经验"] }
    });
  });

  it("removes approval commands whenever unsupported claims are present", async () => {
    const { app } = await buildContentReviewApp("inconsistent");
    const created = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/apply" }
    });

    expect(created.json().commands).not.toContain("approve_content");
  });

  it("lists and commands a task after rebuilding the HTTP application", async () => {
    const first = await buildApp();
    const created = await first.app.inject({
      method: "POST",
      url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/apply" }
    });
    const taskId = created.json().id as string;
    const checkpointCount = first.database.prepare(
      "SELECT COUNT(*) AS count FROM application_checkpoints WHERE task_id = ?"
    ).get(taskId) as { count: number };
    expect(checkpointCount.count).toBeGreaterThan(0);

    const restartedService = createApplicationService({
      checkpoints: createCheckpointRepository(first.database),
      browser: {
        async observe(id) {
          return {frameRef: { documentId: fixtureNodeRef.documentId, kind: "main" as const }, mutationEpoch: fixtureNodeRef.observedAt, 
            id: `snapshot-${id}`,
            taskId: id,
            url: "https://jobs.example.test/apply",
            title: "Login",
            stage: "login" as const,
            fields: [], actions: [], errors: []
          };
        },
        async execute() { throw new Error("not used"); }
      },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused",
      applyAnswers: async () => undefined
    });
    const restarted = await createApp({
      database: first.database,
      adapterHealth: createAdapterHealthRegistry(),
      profileRepository: first.profileRepository,
      originalDocumentStore: createLocalOriginalDocumentStore(first.storageRoot),
      extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }),
      extractFacts: async () => [],
      applicationService: restartedService,
      taskEvents: createTaskEventBus(first.database)
    });

    const listed = await restarted.inject({ method: "GET", url: "/api/applications" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([expect.objectContaining({ id: taskId, state: "waiting_for_login" })]);
    const cancelled = await restarted.inject({
      method: "POST",
      url: `/api/applications/${taskId}/commands`,
      payload: { type: "cancel" }
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ state: "cancelled", commands: [] });
    await restarted.close();
  });

  it("re-observes a transient checkpoint without replaying browser mutations", async () => {
    const first = await buildApp();
    const task = {
      id: "a6ff8a62-af7b-4cab-966c-f2ea206fbf42",
      applicationUrl: "https://jobs.example.test/recover"
    };
    const staleSnapshot = {frameRef: { documentId: fixtureNodeRef.documentId, kind: "main" as const }, mutationEpoch: fixtureNodeRef.observedAt, 
      id: "snapshot-before-restart",
      taskId: task.id,
      url: task.applicationUrl,
      title: "Application",
      stage: "application_form" as const,
      fields: [],
      actions: [],
      errors: []
    };
    createApplicationTaskRepository(first.database).create(task);
    createCheckpointRepository(first.database).save({
      taskId: task.id,
      state: "filling",
      url: staleSnapshot.url,
      stage: staleSnapshot.stage,
      snapshotId: staleSnapshot.id,
      fieldIds: [],
      questions: [],
      snapshot: staleSnapshot
    });
    const open = vi.fn(async () => ({ type: "opened" as const }));
    const execute = vi.fn();
    const observe = vi.fn(async () => ({
      ...staleSnapshot,
      id: "snapshot-after-restart",
      title: "Login",
      stage: "login" as const
    }));
    const restartedService = createApplicationService({
      checkpoints: createCheckpointRepository(first.database),
      browser: { open, observe, execute },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused",
      applyAnswers: vi.fn()
    });
    const restarted = await createApp({
      database: first.database,
      adapterHealth: createAdapterHealthRegistry(),
      profileRepository: first.profileRepository,
      originalDocumentStore: createLocalOriginalDocumentStore(first.storageRoot),
      extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }),
      extractFacts: async () => [],
      applicationService: restartedService,
      taskEvents: createTaskEventBus(first.database)
    });

    expect((await restarted.inject({ method: "GET", url: `/api/applications/${task.id}` })).json())
      .toMatchObject({ state: "observing_page", commands: ["cancel", "resume"] });
    const recovered = await restarted.inject({
      method: "POST",
      url: `/api/applications/${task.id}/commands`,
      payload: { type: "resume" }
    });

    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ state: "waiting_for_login" });
    expect(open).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(task.id);
    expect(execute).not.toHaveBeenCalled();
    await restarted.close();
  });

  it("opens, resumes, and cancels through the allowed command states", async () => {
    const { app, open } = await buildApp({ observeStages: ["login", "application_form"] });
    const created = await app.inject({
      method: "POST", url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/apply" }
    });
    const taskId = created.json().id as string;
    expect(created.json()).toMatchObject({ state: "waiting_for_login" });

    const opened = await app.inject({
      method: "POST", url: `/api/applications/${taskId}/commands`, payload: { type: "open_browser" }
    });
    expect(opened.statusCode).toBe(200);
    expect(open).toHaveBeenCalledTimes(2);

    const resumed = await app.inject({
      method: "POST", url: `/api/applications/${taskId}/commands`, payload: { type: "resume" }
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().state).not.toBe("waiting_for_login");

    const cancellationHarness = await buildApp();
    const second = await cancellationHarness.app.inject({
      method: "POST", url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/second" }
    });
    const cancelled = await cancellationHarness.app.inject({
      method: "POST", url: `/api/applications/${second.json().id}/commands`, payload: { type: "cancel" }
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ state: "cancelled", commands: [] });
  });

  it("projects a challenge pause and exposes only cancel plus explicit challenge resume", async () => {
    const { app, applicationService } = await buildApp({
      observeStages: ["application_form", "review"],
      challengeFirstObservation: true,
      invalidateExecution: vi.fn(async () => undefined)
    });
    const resume = vi.spyOn(applicationService, "resume");
    const resumeAfterChallenge = vi.spyOn(applicationService, "resumeAfterChallenge");
    const created = await app.inject({
      method: "POST",
      url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/challenge" }
    });
    const taskId = created.json().id as string;

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      state: "awaiting_challenge",
      commands: ["cancel", "resume_after_challenge"],
      challenge: { kind: "captcha" }
    });

    for (const type of ["resume", "sync_profile"] as const) {
      const rejected = await app.inject({
        method: "POST",
        url: `/api/applications/${taskId}/commands`,
        payload: { type }
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ code: "application_command_not_allowed" });
    }
    for (const type of ["retry_current", "manual_done"] as const) {
      const rejected = await app.inject({
        method: "POST",
        url: `/api/applications/${taskId}/recovery`,
        payload: { type }
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ code: "recovery_command_not_allowed" });
    }

    const resumed = await app.inject({
      method: "POST",
      url: `/api/applications/${taskId}/commands`,
      payload: { type: "resume_after_challenge" }
    });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ state: "review_locked", commands: [] });
    expect(resumeAfterChallenge).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
  });

  it("exposes profile resumption only for a waiting question task", async () => {
    const question = await buildQuestionApp();
    const created = await question.app.inject({
      method: "POST", url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/profile-retry" }
    });
    const taskId = created.json().id as string;
    expect(created.json().state).toBe("needs_questions");
    expect(created.json().commands).toContain("resume_with_profile");

    const resumed = await question.app.inject({
      method: "POST", url: `/api/applications/${taskId}/commands`, payload: { type: "resume_with_profile" }
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().state).toBe("needs_questions");

    const regular = await buildApp({ observeStages: ["login"] });
    const regularTask = await regular.app.inject({
      method: "POST", url: "/api/applications",
      payload: { applicationUrl: "https://jobs.example.test/profile-retry-locked" }
    });
    const rejected = await regular.app.inject({
      method: "POST", url: `/api/applications/${regularTask.json().id}/commands`, payload: { type: "resume_with_profile" }
    });
    expect(rejected.statusCode).toBe(409);
  });

  it("blocks a second task while the controlled browser is in use and releases it after cancellation", async () => {
    const { app } = await buildApp();
    const first = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/first" }
    });
    expect(first.statusCode).toBe(201);

    const blocked = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/second" }
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      code: "browser_task_in_use",
      taskId: first.json().id
    });

    const cancelled = await app.inject({
      method: "POST", url: `/api/applications/${first.json().id}/commands`, payload: { type: "cancel" }
    });
    expect(cancelled.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/second" }
    });
    expect(second.statusCode).toBe(201);
  });

  it("waits for browser execution invalidation and task release before completing cancellation", async () => {
    const calls: string[] = [];
    let finishRelease: (() => void) | undefined;
    const releasePending = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const { app } = await buildApp({
      async invalidateExecution(taskId) {
        calls.push(`invalidate:${taskId}`);
      },
      async releaseTask(taskId) {
        calls.push(`release:${taskId}`);
        await releasePending;
      }
    });
    const created = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/cancel" }
    });
    const taskId = created.json().id as string;
    let completed = false;

    const cancellation = app.inject({
      method: "POST", url: `/api/applications/${taskId}/commands`, payload: { type: "cancel" }
    }).then((response) => {
      completed = true;
      return response;
    });
    await vi.waitFor(() => expect(calls).toEqual([
      `invalidate:${taskId}`,
      `release:${taskId}`
    ]));

    expect(completed).toBe(false);
    finishRelease?.();
    const cancelled = await cancellation;
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ state: "cancelled", commands: [] });
  });

  it("still releases the browser task when execution invalidation fails during cancellation", async () => {
    const releaseTask = vi.fn(async () => undefined);
    const { app } = await buildApp({
      async invalidateExecution() {
        throw new Error("worker disconnected");
      },
      releaseTask
    });
    const created = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/cancel" }
    });
    const taskId = created.json().id as string;

    const cancelled = await app.inject({
      method: "POST", url: `/api/applications/${taskId}/commands`, payload: { type: "cancel" }
    });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ state: "cancelled", commands: [] });
    expect(releaseTask).toHaveBeenCalledWith(taskId);
  });

  it("persists question answers and rejects a cross-task promotion outside the current task state", async () => {
    const { app, profileRepository } = await buildQuestionApp();
    const first = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/one" }
    });
    expect(first.json()).toMatchObject({
      state: "needs_questions",
      questions: [{
        id: "city",
        fieldId: "city",
        fieldPath: "preferences.city",
        label: "城市",
        text: "请选择城市",
        inputType: "text",
        options: [],
        required: true
      }]
    });

    const answered = await app.inject({
      method: "POST",
      url: `/api/applications/${first.json().id}/commands`,
      payload: { type: "answer_questions", answers: [{ id: "city", value: "杭州", promoteToProfile: true }] }
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toMatchObject({
      taskAnswers: [{ id: expect.any(String), fieldPath: "preferences.city", value: "杭州" }]
    });
    const answer = profileRepository.resolveForTask(first.json().id, "preferences.city")!;
    expect(answer).toMatchObject({ value: "杭州", scope: "application", taskId: first.json().id });
    expect(profileRepository.listActive()).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldPath: "preferences.city", value: "杭州", scope: "profile" })
    ]));

    const second = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/two" }
    });

    profileRepository.putTaskAnswer(second.json().id, "preferences.city", "Suzhou", [{
      documentId: "user",
      page: 1,
      text: "Suzhou",
      extraction: "user"
    }]);

    const crossTask = await app.inject({
      method: "POST",
      url: `/api/applications/${second.json().id}/commands`,
      payload: { type: "promote_answer_to_profile", answerId: answer.id }
    });
    expect(crossTask.statusCode).toBe(409);
    expect(crossTask.json()).toMatchObject({ code: "application_command_not_allowed" });
  });

  it("rejects content review with its scoped id and removes all further commands", async () => {
    const { app } = await buildContentReviewApp();
    const created = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/apply" }
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/api/applications/${created.json().id}/commands`,
      payload: { type: "reject_content", reviewId: created.json().contentReview.id }
    });

    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ state: "failed", commands: [] });
    expect(rejected.json().contentReview).toBeUndefined();
  });

  it("returns the latest persisted profile synchronization state after a sync command", async () => {
    const { app, database, applicationService } = await buildApp();
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";
    const tasks = createApplicationTaskRepository(database);
    tasks.create({ id: taskId, applicationUrl: "https://jobs.example.test/apply" });
    applicationService.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });
    tasks.markProfileSyncFailed(taskId, "profile_sync_incomplete");
    const snapshot = applicationService.state(taskId);
    vi.spyOn(applicationService, "state").mockReturnValue({
      ...snapshot,
      value: "failed"
    } as ReturnType<typeof applicationService.state>);
    vi.spyOn(applicationService, "syncTaskFromProfile").mockImplementation(async () => {
      tasks.markProfileSyncSucceeded(taskId, 5);
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/applications/${taskId}/commands`,
      payload: { type: "sync_profile" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profileRevisionApplied: 5,
      profileSyncStatus: "current"
    });
    expect(response.json()).not.toHaveProperty("profileSyncError");
  });

  it("returns persisted field coverage for one task", async () => {
    const { app, applicationService } = await buildApp();
    const created = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/apply" }
    });
    const taskId = created.json().id as string;
    vi.spyOn(applicationService, "fieldCoverage").mockReturnValue({
      total: 1,
      ready: 0,
      review: 0,
      missing: 1,
      failed: 0,
      unsupported: 0,
      filled: 0,
      fields: [{
        fieldId: "unknown-field",
        label: "未命名字段",
        status: "missing",
        source: "none",
        confidence: 0,
        reason: "档案中没有可安全使用的已确认资料",
        evidence: []
      }]
    });

    const loaded = await app.inject({ method: "GET", url: `/api/applications/${taskId}` });

    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().fieldCoverage).toMatchObject({
      total: 1,
      missing: 1,
      fields: [expect.objectContaining({ fieldId: "unknown-field", status: "missing" })]
    });
  });

  it("gets one task and returns stable errors for malformed and missing task ids", async () => {
    const { app, applicationService } = await buildApp();
    const created = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/apply" }
    });
    const loaded = await app.inject({ method: "GET", url: `/api/applications/${created.json().id}` });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toMatchObject({ id: created.json().id, state: "waiting_for_login" });

    const invalidCreate = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "file:///tmp/resume" }
    });
    expect(invalidCreate.statusCode).toBe(400);
    expect(invalidCreate.json()).toMatchObject({ code: "invalid_application_task_input" });
    const cancelled = await app.inject({
      method: "POST", url: `/api/applications/${created.json().id}/commands`, payload: { type: "cancel" }
    });
    expect(cancelled.statusCode).toBe(200);
    vi.spyOn(applicationService, "start").mockImplementationOnce(() => {
      throw new Error("start failed");
    });
    const failedCreate = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/failure" }
    });
    expect(failedCreate.statusCode).toBe(409);
    expect(failedCreate.json()).toMatchObject({ code: "application_task_creation_failed" });

    const malformed = await app.inject({ method: "GET", url: "/api/applications/not-a-uuid" });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "invalid_task_id" });
    const missing = await app.inject({
      method: "GET", url: "/api/applications/00000000-0000-4000-8000-000000000000"
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "application_task_not_found" });

    const malformedEvents = await app.inject({ method: "GET", url: "/api/applications/not-a-uuid/events" });
    expect(malformedEvents.statusCode).toBe(400);
    expect(malformedEvents.json()).toMatchObject({ code: "invalid_task_id" });
    const missingEvents = await app.inject({
      method: "GET", url: "/api/applications/00000000-0000-4000-8000-000000000000/events"
    });
    expect(missingEvents.statusCode).toBe(404);
    expect(missingEvents.json()).toMatchObject({ code: "application_task_not_found" });
  });

  it("releases the controlled browser lock when task creation fails after the actor starts", async () => {
    const { app, applicationService } = await buildApp();
    vi.spyOn(applicationService, "runUntilPause").mockRejectedValueOnce(new Error("initial observation failed"));
    const dispose = vi.spyOn(applicationService, "dispose");

    const failed = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/failure" }
    });
    expect(dispose).toHaveBeenCalledOnce();
    const retried = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/retry" }
    });

    expect(failed.statusCode).toBe(409);
    expect(retried.statusCode).toBe(201);
  });

  it("deletes only terminal application tasks and disposes their in-memory state", async () => {
    const { app, applicationService } = await buildApp();
    const created = await app.inject({
      method: "POST", url: "/api/applications", payload: { applicationUrl: "https://jobs.example.test/apply" }
    });
    const activeDelete = await app.inject({ method: "DELETE", url: `/api/applications/${created.json().id}` });
    expect(activeDelete.statusCode).toBe(409);
    expect(activeDelete.json()).toMatchObject({ code: "application_task_delete_not_allowed" });

    const cancelled = await app.inject({
      method: "POST", url: `/api/applications/${created.json().id}/commands`, payload: { type: "cancel" }
    });
    expect(cancelled.statusCode).toBe(200);

    const dispose = vi.spyOn(applicationService, "dispose");

    const deleted = await app.inject({ method: "DELETE", url: `/api/applications/${created.json().id}` });
    expect(deleted.statusCode).toBe(204);
    expect(dispose).toHaveBeenCalledWith(created.json().id);
    const missing = await app.inject({ method: "GET", url: `/api/applications/${created.json().id}` });
    expect(missing.statusCode).toBe(404);
  });
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 1_000
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!predicate(text)) {
    if (Date.now() >= deadline) throw new Error(`stream_timeout: ${text}`);
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("stream_timeout")), 100))
    ]);
    if (result.done) throw new Error(`stream_ended: ${text}`);
    text += decoder.decode(result.value, { stream: true });
  }
  return text;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
