import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "../../apps/web/node_modules/vite/dist/node/index.js";
import type { ConversationMessage, ConversationProcessEvent, ConversationView } from "../../packages/contracts/src/conversation.js";
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
  await mockInlineConversation(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${webBaseUrl}/?conversation=conversation-inline`);

  const assistantTurn = page.locator(".conversation-message.assistant").filter({ hasText: "岗位匹配" });
  await expect(assistantTurn.getByRole("list", { name: "执行过程" })).toBeVisible();
  await expect(assistantTurn.getByText("岗位匹配", { exact: true })).toBeVisible();
  await expect(assistantTurn.getByRole("button", { name: "选择此岗位" })).toBeVisible();
  await expect(page.getByRole("button", { name: "打开岗位匹配" })).toHaveCount(0);

  await assistantTurn.getByRole("button", { name: "查看详情" }).click();
  await expect(assistantTurn.getByRole("heading", { name: "匹配依据" })).toBeVisible();

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
  await expect(assistantTurn.getByRole("heading", { name: "匹配依据" })).toBeVisible();

  const mobileScreenshot = await page.screenshot({
    path: "playwright-artifacts/conversation-job-match-flow-mobile.png",
    fullPage: true
  });
  expect(mobileScreenshot.byteLength).toBeGreaterThan(0);
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

async function mockInlineConversation(page: Page): Promise<void> {
  const view = inlineConversationView();
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
      body: JSON.stringify(inlineJobMatchSession())
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
      postingCount: 1
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
    postings: [{
      id: "posting-inline-1",
      source: "moka",
      sourceJobId: "frontend-1",
      canonicalUrl: "https://jobs.example.com/jobs/frontend-1",
      title: "Frontend Engineer",
      organization: "示例公司",
      location: "杭州",
      employmentType: "校招",
      description: "负责前端产品开发",
      requirements: [{
        id: "requirement-inline-1",
        category: "skill",
        normalizedValue: "TypeScript",
        required: true,
        sourceEvidence: "岗位要求 TypeScript"
      }],
      adapterVersion: "moka-v1",
      contentHash: "sha256:posting-inline",
      extractedAt: "2026-09-02T00:00:00.000Z"
    }],
    results: [{
      id: "result-inline-1",
      version: 0,
      sessionId: "match-inline-1",
      postingId: "posting-inline-1",
      fitScore: 88,
      confidence: 91,
      rankingScore: 87,
      outcomes: [{ requirementId: "requirement-inline-1", outcome: "satisfied", reasonCode: "confirmed_skill" }],
      evidence: [{
        requirementId: "requirement-inline-1",
        evidenceId: "evidence-inline-1",
        source: "confirmed_fact",
        quality: 1,
        summary: "简历中有 TypeScript 项目经验"
      }],
      gaps: [],
      scoringVersion: "job-match-v1",
      profileRevision: 1,
      expectationRevision: 1,
      postingContentHash: "sha256:posting-inline",
      stale: false
    }]
  };
}
