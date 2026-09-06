import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "../../apps/web/node_modules/vite/dist/node/index.js";
import type {
  ConversationJobMatchAction,
  ConversationMessage,
  ConversationProcessEvent,
  ConversationView
} from "../../packages/contracts/src/conversation.js";
import type { JobMatchSession } from "../../apps/web/src/job-matching/api.js";

let web: ViteDevServer;
let webBaseUrl: string;

test.beforeAll(async () => {
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
});

test("inline job-match acceptance flow keeps process points and cards in the owning turn", async ({ page }) => {
  const capturedActions: ConversationJobMatchAction[] = [];
  const applicationSideEffects: string[] = [];
  await mockInlineConversation(page, capturedActions, applicationSideEffects);
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
  await expect(firstCard.getByRole("heading", { name: "匹配优势" })).toBeVisible();
  await expect(firstCard.getByRole("heading", { name: "待确认条件" })).toBeVisible();
  await expect(firstCard.getByRole("heading", { name: "差距与风险" })).toBeVisible();
  await expect(firstCard.getByRole("heading", { name: "匹配度如何得出" })).toBeVisible();
  await expect(firstCard).toContainText("你的技能“TypeScript”符合岗位技能要求。");
  await expect(page.locator("body")).not.toContainText(
    /result-inline-|posting-inline-|requirement-inline-|match-inline-1|sha256:|profile\./u
  );

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
  await expect(firstCard.getByRole("heading", { name: "匹配度如何得出" })).toBeVisible();

  const mobileScreenshot = await page.screenshot({
    path: "playwright-artifacts/conversation-job-match-flow-mobile.png",
    fullPage: true
  });
  expect(mobileScreenshot.byteLength).toBeGreaterThan(0);

  await firstCard.getByRole("button", { name: "选择此岗位" }).click();
  await expect.poll(() => capturedActions.length).toBe(1);
  expect(capturedActions[0]).toMatchObject({
    conversationId: "conversation-inline",
    sessionId: "match-inline-1",
    action: "select_result"
  });
  await expect(firstCard).toContainText("已选择，等待受控投递确认");
  expect(applicationSideEffects).toEqual([]);
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
  applicationSideEffects: string[] = []
): Promise<void> {
  const view = inlineConversationView();
  let jobMatchSession = inlineJobMatchSession();
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
    requirements: [{
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
    outcomes: [{
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
    gaps: [],
    scoringVersion: "job-match-v1" as const,
    scoreBreakdown: {
      total: fitScore,
      dimensions: [{
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
