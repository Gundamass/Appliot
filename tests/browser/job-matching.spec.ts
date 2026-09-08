import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "../../apps/web/node_modules/vite/dist/node/index.js";
import { startSyntheticAts, type SyntheticAtsServer } from "../../apps/synthetic-ats/src/server.js";
import { ChallengeDetector } from "../../apps/browser-worker/src/challenge-detector.js";
import { JobObserver } from "../../apps/browser-worker/src/job-observer.js";
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

test("the synthetic list supports structured observation, filter readback and pagination", async ({ page }) => {
  await page.goto(`${ats.baseUrl}/job-list.html?page=1&taskId=observer-flow`);
  const detector = new ChallengeDetector();
  detector.start(page);
  const observer = new JobObserver(page as never, detector);

  const first = await observer.observe("observer-flow");
  expect(first.entryHint).toBe("job_list");
  expect(first.jobCards).toHaveLength(2);
  expect(first.filterState).toContainEqual({ key: "location", values: ["深圳"] });

  const filtered = await observer.applyFilters("observer-flow", {
    source: "moka",
    adapterVersion: "moka-job-v1",
    mapped: [{ criterionIndex: 0, key: "location", values: ["杭州"] }],
    localOnly: []
  });
  expect(await page.locator('select[name="location"]').inputValue()).toBe("杭州");
  expect(filtered.filterState).toContainEqual({ key: "location", values: ["杭州"] });

  const second = await observer.advance("observer-flow");
  expect(second.pagination.current).toBe(2);
  expect(second.jobCards.map((card) => card.title)).toContain("后端架构师");

  await page.goto(`${ats.baseUrl}/job-list.html?page=1&taskId=observer-flow&contentVersion=2`);
  const updated = await observer.observe("observer-flow");
  expect(updated.jobCards).toContainEqual(expect.objectContaining({
    sourceJobId: "java-lead",
    title: "Java 平台技术负责人"
  }));
  await observer.advance("observer-flow");
  expect(new URL(page.url()).searchParams.get("contentVersion")).toBe("2");
  detector.dispose();
});

test("identifies job detail, application, login and challenge boundaries without submitting", async ({ page }) => {
  const detector = new ChallengeDetector();
  detector.start(page);
  const observer = new JobObserver(page as never, detector);

  await page.goto(`${ats.baseUrl}/job-detail.html?taskId=entry-flow&job=java-lead`);
  expect((await observer.observe("entry-flow")).entryHint).toBe("job_detail");

  await page.goto(`${ats.baseUrl}/application?taskId=entry-flow`);
  expect((await observer.observe("entry-flow")).entryHint).toBe("application_form");

  await page.goto(`${ats.baseUrl}/login?taskId=entry-flow`);
  expect((await observer.observe("entry-flow")).entryHint).toBe("login");

  const challengeUrl = "http://jobs.mokahr.com/challenge-p0?taskId=entry-flow&scenario=captcha";
  await page.route(challengeUrl, async (route) => {
    const response = await fetch(`${ats.baseUrl}/challenge-p0?taskId=entry-flow&scenario=captcha`);
    await route.fulfill({
      status: response.status,
      contentType: response.headers.get("content-type") ?? "text/html; charset=utf-8",
      body: await response.text()
    });
  });
  await page.goto(challengeUrl);
  expect((await observer.observe("entry-flow")).challenge?.kind).toBe("captcha");
  expect(ats.state("entry-flow").submissionCount).toBe(0);
  detector.dispose();
});

test("maps the legacy apply view back to chat without exposing a job entry", async ({ page }) => {
  await mockConversationWorkspace(page);
  await page.goto(`${webBaseUrl}/?view=apply`);

  await expect(page.getByRole("heading", { name: "和助手聊聊你的求职计划" })).toBeVisible();
  await expect(page.getByRole("button", { name: "岗位匹配" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "岗位推荐" })).toBeVisible();
});

test("maps the legacy apply view to chat without creating an application task", async ({ page }) => {
  await mockConversationWorkspace(page);
  let applicationCreateCount = 0;
  await page.route("**/api/applications", async (route) => {
    if (route.request().method() === "POST") applicationCreateCount += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unexpected application create" }) });
  });
  await page.goto(`${webBaseUrl}/?view=apply`);

  await expect(page.getByRole("heading", { name: "和助手聊聊你的求职计划" })).toBeVisible();
  await expect(page.getByLabel("投递官网链接")).toHaveCount(0);
  expect(applicationCreateCount).toBe(0);
});

async function mockConversationWorkspace(page: import("@playwright/test").Page): Promise<void> {
  const session = {
    id: "conversation-legacy",
    title: "Legacy conversation",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z"
  };
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([session])
    });
  });
  await page.route("**/api/conversations/conversation-legacy", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session,
        messages: [],
        context: { version: 0, recentPostingIds: [] }
      })
    });
  });
}

