import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import Fastify from "../../apps/api/node_modules/fastify/fastify.js";
import { createServer, type ViteDevServer } from "../../apps/web/node_modules/vite/dist/node/index.js";
import { ActionPolicy } from "../../packages/action-policy/src/index.js";
import { startSyntheticAts, type SyntheticAtsServer } from "../../apps/synthetic-ats/src/server.js";
import { createApplicationService } from "../../apps/api/src/applications/application-service.js";
import { createApplicationTaskRepository } from "../../apps/api/src/applications/application-task-repository.js";
import { createCheckpointRepository } from "../../apps/api/src/applications/checkpoint-repository.js";
import { registerApplicationRoutes } from "../../apps/api/src/applications/routes.js";
import { createTaskEventBus } from "../../apps/api/src/applications/task-events.js";
import { BrowserOwnershipLease } from "../../apps/api/src/browser/browser-ownership-lease.js";
import { BrowserWorkerClient } from "../../apps/api/src/browser/worker-client.js";
import { registerConversationJobMatchRoutes } from "../../apps/api/src/conversations/conversation-job-match-routes.js";
import { createConversationRepository } from "../../apps/api/src/conversations/conversation-repository.js";
import { createConversationJobMatchService } from "../../apps/api/src/conversations/conversation-job-match-service.js";
import { createSqliteDatabase } from "../../apps/api/src/db/client.js";
import { migrateDatabase } from "../../apps/api/src/db/migrate.js";
import { createJobMatchRepository } from "../../apps/api/src/job-matching/job-match-repository.js";
import { createJobMatchService } from "../../apps/api/src/job-matching/job-match-service.js";
import { createProfileRepository } from "../../apps/api/src/profile/profile-repository.js";
import type {
  ConversationJobMatchAction,
  ConversationMessage,
  ConversationProcessEvent,
  ConversationView
} from "../../packages/contracts/src/conversation.js";
import type { JobMatchSession } from "../../apps/web/src/job-matching/api.js";

let web: ViteDevServer;
let webBaseUrl: string;
let ats: SyntheticAtsServer;

test.beforeAll(async () => {
  ats = await startSyntheticAts();
  web = await createServer({
    root: fileURLToPath(new URL("../../apps/web", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "silent"
  });
  await web.listen();
  const address = web.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Web 测试服务器未启动");
  webBaseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await web.close();
  await ats.close();
});

test("inline job-match acceptance flow keeps process points and cards in the owning turn", async ({ page }) => {
  const capturedActions: ConversationJobMatchAction[] = [];
  const applicationSideEffects: string[] = [];
  const fixture = inlineJobMatchSession();
  await mockInlineConversation(page, capturedActions, applicationSideEffects, fixture);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${webBaseUrl}/?conversation=conversation-inline`);

  const assistantTurn = page.locator(".conversation-message.assistant").filter({ hasText: "岗位匹配" });
  await expect(assistantTurn.getByRole("list", { name: "执行过程" })).toBeVisible();
  await expect(assistantTurn.getByText("岗位匹配", { exact: true })).toBeVisible();
  const jobCards = assistantTurn.locator('article[aria-label^="岗位："]');
  await expect(jobCards).toHaveCount(6);
  const percentages = (await jobCards.allTextContents()).map((text) => {
    const match = text.match(/匹配度 (\d+)%/u);
    expect(match, `missing percentage in card: ${text}`).not.toBeNull();
    return Number(match![1]);
  });
  for (let index = 1; index < percentages.length; index += 1) {
    expect(percentages[index - 1]).toBeGreaterThanOrEqual(percentages[index]!);
  }
  await expect(page.getByRole("button", { name: "打开岗位匹配" })).toHaveCount(0);

  const firstCard = jobCards.first();
  await firstCard.getByRole("button", { name: "查看详情" }).click();
  const advantages = firstCard.locator(".conversation-job-card-details section").filter({ hasText: "匹配优势" });
  const unknowns = firstCard.locator(".conversation-job-card-details section").filter({ hasText: "待确认条件" });
  const conflicts = firstCard.locator(".conversation-job-card-details section").filter({ hasText: "差距与风险" });
  const score = firstCard.locator(".conversation-job-card-details section").filter({ hasText: "匹配度如何得出" });
  await expect(advantages.getByRole("heading", { name: "匹配优势" })).toBeVisible();
  await expect(advantages).toContainText("岗位要求熟练掌握 TypeScript");
  await expect(advantages).toContainText("你的技能“TypeScript”符合岗位技能要求。");
  await expect(unknowns.getByRole("heading", { name: "待确认条件" })).toBeVisible();
  await expect(unknowns).toContainText("工作地点需要上海");
  await expect(conflicts.getByRole("heading", { name: "差距与风险" })).toBeVisible();
  await expect(conflicts).toContainText("岗位要求五年工作经验");
  await expect(score.getByRole("heading", { name: "匹配度如何得出" })).toBeVisible();
  await expect(score).toContainText("技能 60/60");
  await expect(score).toContainText("任职资格 20/25");
  await expect(score).toContainText("求职偏好 15/15");
  await expect(score).toContainText("总分 95/100");
  const renderedText = await page.locator("body").innerText();
  const internalValues = fixtureInternalValues(fixture);
  expectNoInternalIdentifiers(renderedText, internalValues);

  const desktopScreenshot = await page.screenshot({
    path: "playwright-artifacts/conversation-job-match-flow-desktop.png",
    fullPage: true
  });
  expect(desktopScreenshot.byteLength).toBeGreaterThan(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileDimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth
  }));
  expect(mobileDimensions.scrollWidth).toBeLessThanOrEqual(mobileDimensions.viewportWidth);
  await expect(assistantTurn.getByRole("list", { name: "执行过程" })).toBeVisible();
  await expect(score.getByRole("heading", { name: "匹配度如何得出" })).toBeVisible();

  const mobileScreenshot = await page.screenshot({
    path: "playwright-artifacts/conversation-job-match-flow-mobile.png",
    fullPage: true
  });
  expect(mobileScreenshot.byteLength).toBeGreaterThan(0);

  const firstNonConflictCard = assistantTurn
    .locator('article[aria-label^="岗位："]:not(.conflict)')
    .first();
  await firstNonConflictCard.getByRole("button", { name: "选择此岗位" }).click();
  await expect.poll(() => capturedActions.length).toBe(1);
  expect(capturedActions[0]).toMatchObject({
    conversationId: "conversation-inline",
    sessionId: "match-inline-1",
    action: "select_result"
  });
  await expect(firstNonConflictCard).toContainText("已选择，等待受控投递确认");
  expectNoInternalIdentifiers(await page.locator("body").innerText(), internalValues);
  expect(applicationSideEffects).toEqual([]);
});

test("HTTP select_result leaves the production-capable application graph and Synthetic ATS untouched", async () => {
  const selectionTaskId = "conversation-selection-safety";
  const applicationControlTaskId = "application-route-control";
  const counterControlTaskId = "submission-counter-control";
  const initialUrl = `${ats.baseUrl}/job-list.html?taskId=${selectionTaskId}`;
  const canonicalUrl = `${ats.baseUrl}/job-detail.html?taskId=${selectionTaskId}&job=frontend-safety`;
  const profileDir = await mkdtemp(join(tmpdir(), "resume-selection-safety-"));
  const database = createSqliteDatabase(":memory:");
  let browser: BrowserWorkerClient | undefined;
  let app: ReturnType<typeof Fastify> | undefined;
  try {
    migrateDatabase(database);
    const initialized = await fetch(canonicalUrl);
    expect(initialized.ok).toBe(true);

    const positiveSubmission = await fetch(`${ats.baseUrl}/submit?taskId=${counterControlTaskId}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "syntheticControl=1"
    });
    expect(positiveSubmission.ok).toBe(true);
    expect(ats.state(counterControlTaskId).submissionCount).toBe(1);

    const approvalKey = Buffer.alloc(32, 41);
    const policy = new ActionPolicy(approvalKey);
    const browserOwnershipLease = new BrowserOwnershipLease();
    browser = await BrowserWorkerClient.start({ profileDir, headless: true, approvalKey });
    const applicationTasks = createApplicationTaskRepository(database);
    const taskEvents = createTaskEventBus(database);
    const profileRepository = createProfileRepository(database);
    const applicationService = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      taskRepository: applicationTasks,
      taskEvents,
      browserOwnershipLease,
      browser: {
        open: (taskId, url) => browser!.open(taskId, url),
        observe: async (taskId) => (await browser!.observe(taskId)).snapshot,
        execute: (command, executionEpoch) => browser!.execute(command, executionEpoch),
        invalidateExecution: (taskId, executionEpoch) => browser!.invalidateExecution(taskId, executionEpoch),
        releaseTask: (taskId) => browser!.releaseTask(taskId),
        onActivity: (listener) => browser!.onActivity(listener)
      },
      resolveField: async (_taskId, field) => {
        const values: Record<string, string> = {
          "邮箱": "synthetic@example.com",
          "城市": "杭州",
          "自我评价": "合成验收数据"
        };
        return field.label in values
          ? { status: "verified" as const, value: values[field.label] }
          : { status: "needs_question" as const, question: `请补充${field.label}` };
      },
      listProfileFacts: () => profileRepository.listActive(),
      approve: (request, snapshot) => policy.approve(request, snapshot, {
        valid: snapshot.errors.length === 0
      }).token
    });

    const jobMatchesRepository = createJobMatchRepository(database);
    const conversations = createConversationRepository(database);
    const conversation = conversations.createConversation();
    const sessionId = "real-selection-session";
    const posting = {
      id: "real-selection-posting",
      source: "moka" as const,
      sourceJobId: "synthetic-frontend-safety",
      canonicalUrl,
      title: "前端安全验收工程师",
      organization: "合成招聘站",
      location: "上海",
      employmentType: "校招",
      description: "用于验证选择岗位不会创建或提交投递。",
      requirements: [{
        id: "real-selection-requirement",
        category: "skill" as const,
        normalizedValue: "TypeScript",
        required: true,
        sourceEvidence: "熟练掌握 TypeScript"
      }],
      adapterVersion: "synthetic-selection-v1",
      contentHash: "sha256:real-selection-posting",
      extractedAt: "2026-09-06T00:00:00.000Z"
    };
    const result = {
      id: "real-selection-result",
      version: 0,
      sessionId,
      postingId: posting.id,
      fitScore: 96,
      confidence: 94,
      rankingScore: 95,
      outcomes: [{
        requirementId: posting.requirements[0]!.id,
        outcome: "satisfied" as const,
        reasonCode: "confirmed_skill"
      }],
      evidence: [{
        requirementId: posting.requirements[0]!.id,
        evidenceId: "real-selection-evidence",
        source: "confirmed_fact" as const,
        quality: 1,
        summary: "你的技能“TypeScript”符合岗位技能要求。"
      }],
      gaps: [],
      scoringVersion: "job-match-v1" as const,
      scoreBreakdown: {
        total: 96,
        dimensions: [{
          dimension: "skill" as const,
          label: "技能",
          earned: 96,
          available: 100,
          satisfied: 1,
          unknown: 0,
          conflict: 0
        }]
      },
      profileRevision: 1,
      expectationRevision: 1,
      postingContentHash: posting.contentHash,
      stale: false
    };
    const expectation = {
      revision: 1,
      confirmedAt: "2026-09-06T00:00:00.000Z",
      criteria: [{ kind: "target_role" as const, values: ["前端工程师"], strength: "required" as const }]
    };
    jobMatchesRepository.create({
      id: sessionId,
      initialUrl,
      state: "awaiting_job_selection",
      profileRevision: 1,
      expectation,
      createdAt: "2026-09-06T00:00:00.000Z"
    });
    jobMatchesRepository.saveExtractionPage({
      sessionId,
      idempotencyKey: "real-selection-seed",
      postings: [posting],
      cursor: { value: "done", pagesRead: 1, elapsedMs: 1, newJobs: 1, consecutiveNoNewPages: 0 },
      event: { type: "seed", payload: {} },
      createdAt: "2026-09-06T00:00:00.100Z"
    });
    jobMatchesRepository.saveResults(sessionId, [result], "2026-09-06T00:00:00.200Z");
    conversations.linkJobMatchSession(conversation.id, sessionId);

    const jobMatches = createJobMatchService({
      repository: jobMatchesRepository,
      applicationTasks,
      browser: {
        open: (ownerId, url) => browser!.open(ownerId, url),
        observeJob: (ownerId) => browser!.observeJob(ownerId),
        invalidateExecution: (ownerId, executionEpoch) => browser!.invalidateExecution(ownerId, executionEpoch),
        releaseTask: (ownerId) => browser!.releaseTask(ownerId)
      },
      browserOwnershipLease,
      adapters: [],
      expectationSnapshot: () => expectation,
      profileRevision: () => 1,
      extraction: {
        confirmFilters: async () => undefined,
        runExtraction: async () => undefined
      },
      matcher: { match: async () => undefined },
      prepareApplicationTask: (input) => applicationService.start(input),
      submissionCount: () => ats.state(selectionTaskId).submissionCount
    });
    const conversationJobMatches = createConversationJobMatchService({
      conversations,
      jobMatches,
      now: () => new Date("2026-09-06T00:00:01.000Z")
    });
    app = Fastify();
    registerApplicationRoutes(app, {
      applicationService,
      taskEvents,
      tasks: applicationTasks,
      profileRepository,
    });
    registerConversationJobMatchRoutes(app, { service: conversationJobMatches });
    await app.ready();

    const applicationControl = await app.inject({
      method: "POST",
      url: "/api/applications",
      payload: {
        applicationUrl: `${ats.baseUrl}/application?taskId=${applicationControlTaskId}&scenario=default`
      }
    });
    expect(applicationControl.statusCode).toBe(201);
    const applicationTask = applicationControl.json() as { id: string; state: string };
    for (let step = 0; step < 5 && applicationService.state(applicationTask.id).value !== "review_locked"; step += 1) {
      await applicationService.runUntilPause(applicationTask.id);
    }
    const applicationState = await app.inject({ method: "GET", url: `/api/applications/${applicationTask.id}` });
    expect(applicationState.statusCode).toBe(200);
    expect(applicationState.json()).toMatchObject({ state: "review_locked" });
    const terminalActions = (await browser.observe(applicationTask.id)).snapshot.actions
      .filter((action) => action.class === "terminal_submit");
    expect(terminalActions.length).toBeGreaterThan(0);
    expect(ats.state(applicationControlTaskId)).toMatchObject({
      submissionCount: 0,
      draft: {
        email: "synthetic@example.com",
        city: "hangzhou",
        selfEvaluation: "合成验收数据"
      }
    });
    const deletedControl = await app.inject({ method: "DELETE", url: `/api/applications/${applicationTask.id}` });
    expect(deletedControl.statusCode).toBe(204);
    expect(applicationTasks.list()).toHaveLength(0);

    const selectionResponse = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/job-match-actions`,
      payload: {
        conversationId: conversation.id,
        sessionId,
        action: "select_result",
        sessionVersion: 0,
        idempotencyKey: "real-select-result",
        resultId: result.id,
        resultVersion: result.version,
        postingContentHash: result.postingContentHash
      }
    });

    expect(selectionResponse.statusCode).toBe(200);
    expect(selectionResponse.json()).toMatchObject({ sessionId, state: "selected", version: 1 });
    expect(jobMatchesRepository.get(sessionId, { required: true })).toMatchObject({
      state: "selected",
      version: 1,
      selectedResultId: result.id,
      selectedPostingContentHash: result.postingContentHash
    });
    expect(applicationTasks.list()).toHaveLength(0);
    expect(ats.state(selectionTaskId).submissionCount).toBe(0);
    expect(ats.state(counterControlTaskId).submissionCount).toBe(1);
  } finally {
    await app?.close();
    await browser?.stop();
    database.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

test("legacy job-match URL returns to the owning conversation instead of rendering a workbench", async ({ page }) => {
  await mockInlineConversation(page);
  await page.route("**/api/job-match-sessions/legacy-session/conversation", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ conversationId: "conversation-inline" })
    });
  });

  await page.goto(`${webBaseUrl}/job-match-sessions/legacy-session`);

  await expect(page).toHaveURL(`${webBaseUrl}/?conversation=conversation-inline`);
  await expect(page.getByRole("heading", { name: "和助手聊聊你的求职计划" })).toBeVisible();
  await expect(page.getByRole("list", { name: "执行过程" })).toBeVisible();
  await expect(page.getByText("岗位匹配工作台", { exact: true })).toHaveCount(0);
});

async function mockInlineConversation(
  page: Page,
  capturedActions: ConversationJobMatchAction[] = [],
  applicationSideEffects: string[] = [],
  initialJobMatchSession = inlineJobMatchSession()
): Promise<void> {
  const view = inlineConversationView();
  let jobMatchSession = initialJobMatchSession;
  page.on("request", (request) => {
    if (request.method() === "GET") return;
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) return;
    const payload = request.postData() ?? "";
    const createsApplicationTask = request.method() === "POST" && (
      pathname === "/api/applications"
      || /^\/api\/job-match-sessions\/[^/]+\/application$/u.test(pathname)
    );
    const submitsApplication = request.method() === "POST" && (
      /^\/api\/applications\/[^/]+\/(?:submit|final-submit)$/u.test(pathname)
      || (/^\/api\/applications\/[^/]+\/commands$/u.test(pathname)
        && /final_submit|terminal_submit|"submit"/u.test(payload))
    );
    if (createsApplicationTask || submitsApplication) {
      applicationSideEffects.push(`${request.method()} ${pathname}`);
    }
  });
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([view.session])
    });
  });
  await page.route("**/api/conversations/conversation-inline", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(view)
    });
  });
  await page.route("**/api/conversations/conversation-inline/job-match-actions", async (route) => {
    const action = route.request().postDataJSON() as ConversationJobMatchAction;
    capturedActions.push(action);
    if (action.action !== "select_result") {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "unexpected job-match action" })
      });
      return;
    }
    const selectedResult = jobMatchSession.results.find((result) => result.id === action.resultId);
    if (selectedResult === undefined) throw new Error("selected fixture result is missing");
    jobMatchSession = {
      ...jobMatchSession,
      version: jobMatchSession.version + 1,
      state: "selected",
      selectedResultId: selectedResult.id,
      selectedPostingContentHash: selectedResult.postingContentHash,
      updatedAt: "2026-09-02T00:00:02.000Z"
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: jobMatchSession.id,
        state: jobMatchSession.state,
        version: jobMatchSession.version,
        turnSequence: 3,
        message: {
          id: "conversation-message-assistant-4",
          sessionId: "conversation-inline",
          sequence: 4,
          role: "assistant",
          text: "已选择岗位，等待受控投递确认。",
          cards: [],
          createdAt: "2026-09-02T00:00:02.000Z"
        },
        cards: [],
        context: {
          activeJobMatchSessionId: jobMatchSession.id,
          recentPostingIds: jobMatchSession.postings.map((posting) => posting.id),
          selectedPostingId: selectedResult.postingId,
          version: 2
        }
      })
    });
  });
  await page.route("**/api/conversations/conversation-inline/events", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache", connection: "keep-alive" },
      body: `event: process_changed\nid: 1\ndata: ${JSON.stringify(processEvent())}\n\n`
    });
  });
  await page.route("**/api/job-match-sessions/match-inline-1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(jobMatchSession)
    });
  });
}

function inlineConversationView(): ConversationView {
  const sessionId = "conversation-inline";
  const user: ConversationMessage = {
    id: "conversation-message-user-1",
    sessionId,
    sequence: 1,
    role: "user",
    text: "帮我投递百度",
    cards: [],
    createdAt: "2026-09-02T00:00:00.000Z"
  };
  const assistant: ConversationMessage = {
    id: "conversation-message-assistant-2",
    sessionId,
    sequence: 2,
    role: "assistant",
    text: "已完成岗位匹配，请查看岗位卡片。",
    cards: [{
      type: "job_match_session",
      sessionId: "match-inline-1",
      initialUrl: "https://jobs.example.com/campus",
      state: "awaiting_job_selection",
      postingCount: 7
    }],
    createdAt: "2026-09-02T00:00:01.000Z"
  };
  return {
    session: {
      id: sessionId,
      title: "百度岗位匹配",
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:01.000Z"
    },
    messages: [user, assistant],
    context: {
      activeJobMatchSessionId: "match-inline-1",
      recentPostingIds: ["posting-inline-1"],
      version: 1
    }
  };
}

function processEvent(): ConversationProcessEvent {
  return {
    id: "1",
    conversationId: "conversation-inline",
    turnSequence: 1,
    stepId: "inline-match-1",
    type: "process_changed",
    stage: "matching_jobs",
    status: "completed",
    summary: "已完成岗位匹配",
    createdAt: "2026-09-02T00:00:01.000Z"
  };
}

function inlineJobMatchSession(): JobMatchSession {
  const fixtures = [
    { ordinal: 5, fitScore: 84, confidence: 82 },
    { ordinal: 2, fitScore: 95, confidence: 90 },
    { ordinal: 7, fitScore: 72, confidence: 75 },
    { ordinal: 1, fitScore: 91, confidence: 88 },
    { ordinal: 4, fitScore: 88, confidence: 86 },
    { ordinal: 6, fitScore: 91, confidence: 92 },
    { ordinal: 3, fitScore: 67, confidence: 99 }
  ];
  const postings = fixtures.map(({ ordinal }) => ({
    id: `posting-inline-${ordinal}`,
    source: "moka" as const,
    sourceJobId: `frontend-${ordinal}`,
    canonicalUrl: `https://jobs.example.com/jobs/frontend-${ordinal}`,
    title: `前端工程师 ${ordinal}`,
    organization: "示例公司",
    location: "杭州",
    employmentType: "校招",
    description: "负责前端产品开发",
    requirements: ordinal === 2 ? [{
      id: "requirement-skill-inline-2",
      category: "skill" as const,
      normalizedValue: "TypeScript",
      required: true,
      sourceEvidence: "岗位要求熟练掌握 TypeScript"
    }, {
      id: "requirement-location-inline-2",
      category: "location" as const,
      normalizedValue: "上海",
      required: false,
      sourceEvidence: "工作地点需要上海"
    }, {
      id: "requirement-experience-inline-2",
      category: "experience_years" as const,
      normalizedValue: "5",
      required: true,
      sourceEvidence: "岗位要求五年工作经验"
    }] : [{
      id: `requirement-inline-${ordinal}`,
      category: "skill" as const,
      normalizedValue: "TypeScript",
      required: true,
      sourceEvidence: "岗位要求熟练掌握 TypeScript"
    }],
    adapterVersion: "moka-v1",
    contentHash: `sha256:posting-inline-${ordinal}`,
    extractedAt: "2026-09-02T00:00:00.000Z"
  }));
  const results = fixtures.map(({ ordinal, fitScore, confidence }, index) => ({
    id: `result-inline-${ordinal}`,
    version: 0,
    sessionId: "match-inline-1",
    postingId: postings[index]!.id,
    fitScore,
    confidence,
    rankingScore: fitScore,
    outcomes: ordinal === 2 ? [{
      requirementId: "requirement-skill-inline-2",
      outcome: "satisfied" as const,
      reasonCode: "confirmed_skill"
    }, {
      requirementId: "requirement-location-inline-2",
      outcome: "unknown" as const,
      reasonCode: "location_unconfirmed"
    }, {
      requirementId: "requirement-experience-inline-2",
      outcome: "conflict" as const,
      reasonCode: "experience_conflict"
    }] : [{
      requirementId: postings[index]!.requirements[0]!.id,
      outcome: "satisfied" as const,
      reasonCode: "confirmed_skill"
    }],
    evidence: [{
      requirementId: postings[index]!.requirements[0]!.id,
      evidenceId: `evidence-inline-${ordinal}`,
      source: "confirmed_fact" as const,
      quality: 1,
      summary: "你的技能“TypeScript”符合岗位技能要求。"
    }],
    gaps: ordinal === 2 ? [{
      requirementId: "requirement-location-inline-2",
      outcome: "unknown" as const,
      summary: "尚未确认上海工作地点偏好"
    }, {
      requirementId: "requirement-experience-inline-2",
      outcome: "conflict" as const,
      summary: "已确认经验年限与岗位要求存在差距"
    }] : [],
    scoringVersion: "job-match-v1" as const,
    scoreBreakdown: {
      total: fitScore,
      dimensions: ordinal === 2 ? [{
        dimension: "skill" as const,
        label: "技能",
        earned: 60,
        available: 60,
        satisfied: 1,
        unknown: 0,
        conflict: 0
      }, {
        dimension: "qualification" as const,
        label: "任职资格",
        earned: 20,
        available: 25,
        satisfied: 0,
        unknown: 0,
        conflict: 1
      }, {
        dimension: "preference" as const,
        label: "求职偏好",
        earned: 15,
        available: 15,
        satisfied: 0,
        unknown: 1,
        conflict: 0
      }] : [{
        dimension: "skill" as const,
        label: "技能",
        earned: fitScore,
        available: 100,
        satisfied: 1,
        unknown: 0,
        conflict: 0
      }]
    },
    profileRevision: 1,
    expectationRevision: 1,
    postingContentHash: postings[index]!.contentHash,
    stale: false
  }));
  return {
    id: "match-inline-1",
    version: 3,
    state: "awaiting_job_selection",
    initialUrl: "https://jobs.example.com/campus",
    scoringVersion: "job-match-v1",
    profileRevision: 1,
    expectationRevision: 1,
    executionEpoch: 1,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:01.000Z",
    source: "moka",
    adapterVersion: "moka-v1",
    expectation: {
      revision: 1,
      confirmedAt: "2026-09-02T00:00:00.000Z",
      criteria: [{ kind: "target_role", values: ["Frontend Engineer"], strength: "required" }]
    },
    postings,
    results
  };
}

function fixtureInternalValues(session: JobMatchSession): string[] {
  const values = new Set<string>([
    session.id,
    session.initialUrl,
    ...(session.adapterVersion === undefined ? [] : [session.adapterVersion]),
    session.scoringVersion
  ]);
  for (const posting of session.postings) {
    values.add(posting.id);
    if (posting.sourceJobId !== undefined) values.add(posting.sourceJobId);
    values.add(posting.canonicalUrl);
    values.add(new URL(posting.canonicalUrl).pathname);
    values.add(posting.adapterVersion);
    values.add(posting.contentHash);
    for (const requirement of posting.requirements) values.add(requirement.id);
  }
  for (const result of session.results) {
    values.add(result.id);
    values.add(result.sessionId);
    values.add(result.postingId);
    values.add(result.postingContentHash);
    values.add(result.scoringVersion);
    for (const outcome of result.outcomes) {
      values.add(outcome.requirementId);
      values.add(outcome.reasonCode);
    }
    for (const evidence of result.evidence) {
      values.add(evidence.requirementId);
      values.add(evidence.evidenceId);
    }
    for (const gap of result.gaps) values.add(gap.requirementId);
  }
  return [...values];
}

function expectNoInternalIdentifiers(renderedText: string, internalValues: string[]): void {
  for (const internalValue of internalValues) {
    expect(renderedText).not.toContain(internalValue);
  }
  expect(renderedText).not.toMatch(
    /(?:https?:\/\/|\/api\/|\/jobs?\/[^\s]+|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b[0-9a-f]{24,}\b|\b[A-Za-z0-9_-]{32,}\b|\b(?:result|posting|requirement|evidence|session|match)[-_][a-z0-9][a-z0-9_-]*\b|sha256:|profile\.|(?:[a-z]:\\|\/(?:users|home|var|tmp)\/)[^\s]+)/iu
  );
}
