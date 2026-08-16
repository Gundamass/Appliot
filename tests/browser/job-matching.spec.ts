import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "../../apps/web/node_modules/vite/dist/node/index.js";
import { startSyntheticAts, type SyntheticAtsServer } from "../../apps/synthetic-ats/src/server.js";
import { ChallengeDetector } from "../../apps/browser-worker/src/challenge-detector.js";
import { JobObserver } from "../../apps/browser-worker/src/job-observer.js";
import type { JobMatchSession } from "../../apps/web/src/job-matching/api.js";

type JobPosting = JobMatchSession["postings"][number];
type JobMatchResult = JobMatchSession["results"][number];

const sessionId = "job-match-browser-session";
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

test("starts job matching from the workspace and never submits the ATS", async ({ page }) => {
  const taskId = "job-match-entry-flow";
  await mockProfileAndCreateSession(page, sessionFixture());
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${webBaseUrl}/?view=apply`);

  await expect(page.getByRole("button", { name: "岗位匹配" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("招聘链接").fill(`${ats.baseUrl}/job-list.html?page=1&taskId=${taskId}`);
  await page.getByRole("button", { name: "确认岗位期望并开始匹配" }).click();

  await expect(page).toHaveURL(new RegExp(`/job-match-sessions/${sessionId}$`, "u"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  expect(ats.state(taskId).submissionCount).toBe(0);
});

test("prefills an application redirect without creating or submitting a task", async ({ page }) => {
  const taskId = "job-match-application-redirect";
  let applicationCreateCount = 0;
  await mockProfileAndCreateSession(page, {
    redirect: "application",
    applicationUrl: `${ats.baseUrl}/application?taskId=${taskId}`
  });
  await page.route("**/api/applications", async (route) => {
    if (route.request().method() === "POST") applicationCreateCount += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unexpected application create" }) });
  });
  await page.goto(`${webBaseUrl}/?view=apply`);

  await page.getByLabel("招聘链接").fill(`${ats.baseUrl}/application?taskId=${taskId}`);
  await page.getByRole("button", { name: "确认岗位期望并开始匹配" }).click();

  await expect(page.getByRole("button", { name: "直接投递" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("投递官网链接")).toHaveValue(`${ats.baseUrl}/application?taskId=${taskId}`);
  await page.getByLabel("任务名称").fill("人工确认后的投递任务");
  await expect(page.getByLabel("任务名称")).toHaveValue("人工确认后的投递任务");
  expect(applicationCreateCount).toBe(0);
  expect(ats.state(taskId).submissionCount).toBe(0);
});

test("reads a synthetic job list and renders recommendation and conflict paths with zero submissions", async ({ page }) => {
  const taskId = "job-match-list-flow";
  await page.goto(`${ats.baseUrl}/job-list.html?page=1&taskId=${taskId}`);
  await expect(page.locator("body")).toHaveAttribute("data-fixture", "job-list");
  await expect(page.getByRole("heading", { name: "Java 技术负责人" })).toBeVisible();

  let current = sessionFixture();
  let conflictSelection: Record<string, unknown> | undefined;
  await mockSession(page, () => current, (session, request) => {
    if (!new URL(request.url()).pathname.endsWith("/conflict-selection")) return;
    conflictSelection = request.postDataJSON() as Record<string, unknown>;
    current = {
      ...session,
      version: session.version + 1,
      state: "selected",
      selectedResultId: "conflict-result",
      selectedPostingContentHash: "sha256:conflict"
    };
    return current;
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${webBaseUrl}/job-match-sessions/${sessionId}`);

  await expect(page.getByRole("heading", { name: "岗位匹配" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "推荐岗位" })).toBeVisible();
  await expect(page.getByText("Java 技术负责人", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "最接近但有冲突" })).toBeVisible();
  await page.getByRole("button", { name: /后端架构师/u }).click();
  await expect(page.getByRole("button", { name: "确认选择冲突岗位" })).toBeVisible();
  await page.getByRole("button", { name: "确认选择冲突岗位" }).click();
  await expect(page.getByText("已选择，尚未创建投递任务")).toBeVisible();
  expect(conflictSelection).toMatchObject({
    sessionVersion: 3,
    resultId: "conflict-result",
    resultVersion: 0,
    postingContentHash: "sha256:conflict"
  });
  expect(conflictSelection?.conflictSummaryHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  await expect(page.getByRole("button", { name: /自动申请|最终提交/u })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  expect(ats.state(taskId).submissionCount).toBe(0);
});

test("pauses and continues job reading through the workbench projection", async ({ page }) => {
  const taskId = "job-match-pause-flow";
  let current = { ...sessionFixture(), state: "extracting_jobs", version: 4 };
  const mutations: string[] = [];
  const pageErrors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
  await page.route("**/api/job-match-sessions/**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current) });
      return;
    }
    const pathname = new URL(request.url()).pathname;
    mutations.push(pathname);
    current = {
      ...current,
      version: current.version + 1,
      state: pathname.endsWith("/pause") ? "paused" : "extracting_jobs"
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current) });
  });
  await page.goto(`${webBaseUrl}/job-match-sessions/${sessionId}`);
  await expect(page.getByRole("button", { name: "暂停读取" })).toBeVisible();
  pageErrors.length = 0;
  requests.length = 0;

  await page.getByRole("button", { name: "暂停读取" }).click();
  await page.waitForTimeout(100);
  expect(requests.some((request) => request.endsWith(`/api/job-match-sessions/${sessionId}/pause`))).toBe(true);
  await expect.poll(() => mutations.at(-1)).toBe(`/api/job-match-sessions/${sessionId}/pause`);
  await expect.poll(() => current.state).toBe("paused");
  expect(pageErrors).toEqual([]);
  await expect(page.getByRole("button", { name: "继续读取" })).toBeVisible();
  await page.getByRole("button", { name: "继续读取" }).click();
  await expect(page.getByRole("button", { name: "暂停读取" })).toBeVisible();

  expect(mutations.map((path) => path.split("/").at(-1))).toEqual(["pause", "continue-extraction"]);
  expect(ats.state(taskId).submissionCount).toBe(0);
});

test("recovers login and challenge pauses through fresh workbench projections", async ({ page }) => {
  const taskId = "job-match-recovery-flow";
  let current: JobMatchSession = { ...sessionFixture(), state: "awaiting_login", version: 6 };
  const recoveryPaths: string[] = [];
  await mockSession(page, () => current, (session, request) => {
    const pathname = new URL(request.url()).pathname;
    recoveryPaths.push(pathname);
    current = {
      ...session,
      version: session.version + 1,
      state: session.state === "awaiting_challenge" ? "awaiting_job_selection" : "extracting_jobs"
    };
    return current;
  });
  await page.goto(`${webBaseUrl}/job-match-sessions/${sessionId}`);

  await expect(page.getByText("等待登录", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续读取" }).click();
  await expect(page.getByRole("button", { name: "暂停读取" })).toBeVisible();

  current = { ...current, state: "awaiting_challenge", version: current.version + 1 };
  await page.reload();
  await expect(page.getByText("等待人工处理", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续读取" }).click();
  await expect(page.getByText("等待选岗", { exact: true })).toBeVisible();

  expect(recoveryPaths.map((path) => path.split("/").at(-1))).toEqual([
    "continue-extraction",
    "continue-extraction"
  ]);
  expect(ats.state(taskId).submissionCount).toBe(0);
});

test("content updates transition fresh results to stale and expose only rematching", async ({ page }) => {
  let current = sessionFixture();
  await mockSession(page, () => current, () => undefined);
  await page.goto(`${webBaseUrl}/job-match-sessions/${sessionId}`);
  await page.getByRole("button", { name: /后端架构师/u }).click();
  await expect(page.getByRole("button", { name: "确认选择冲突岗位" })).toBeVisible();

  current = sessionFixture(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "重新匹配" })).toBeVisible();
  await expect(page.getByRole("button", { name: "继续读取" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "确认选择冲突岗位" })).toHaveCount(0);
});

async function mockSession(page: Page, read: () => JobMatchSession, write: (session: JobMatchSession, request: import("@playwright/test").Request) => JobMatchSession | void): Promise<void> {
  await page.route("**/api/job-match-sessions/**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(read()) });
      return;
    }
    const next = write(read(), request) ?? read();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(next) });
  });
}

async function mockProfileAndCreateSession(
  page: Page,
  createResult: JobMatchSession | { redirect: "application"; applicationUrl: string }
): Promise<void> {
  const profileFact = {
    id: "target-role",
    fieldPath: "preferences.targetRole",
    value: "Java 技术负责人",
    status: "user_confirmed",
    confidence: 1,
    scope: "profile",
    evidence: [{ documentId: "synthetic", page: 1, text: "Java 技术负责人", extraction: "user" }],
    revision: 1
  };
  await page.route("**/api/profile/facts", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([profileFact]) });
  });
  await page.route("**/api/profile/completeness", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ completed: 1, total: 1, sections: [] }) });
  });
  await page.route(/\/api\/job-match-sessions(?:\/[^/]+)?$/u, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const payload = request.method() === "POST" && pathname === "/api/job-match-sessions"
      ? createResult
      : "redirect" in createResult ? undefined : createResult;
    await route.fulfill({
      status: payload === undefined ? 404 : 200,
      contentType: "application/json",
      body: JSON.stringify(payload ?? { error: "session not found" })
    });
  });
}

function sessionFixture(stale = false): JobMatchSession {
  const posting = (id: string, title: string, hash: string): JobPosting => ({
    id, source: "moka", sourceJobId: id, canonicalUrl: `${ats.baseUrl}/jobs?job=${id}`,
    title, organization: "示例公司", location: "深圳", description: "合成岗位描述",
    requirements: [{ id: `${id}-requirement`, category: "experience_years", normalizedValue: "5年以上", required: true, sourceEvidence: "要求 5 年以上经验" }],
    adapterVersion: "moka-v1", contentHash: hash, extractedAt: "2026-08-16T00:00:00.000Z"
  });
  const recommended = posting("java-lead", "Java 技术负责人", "sha256:recommended");
  const conflict = posting("backend-architect", "后端架构师", "sha256:conflict");
  const result = (id: string, job: JobPosting, outcome: "unknown" | "conflict"): JobMatchResult => ({
    id, version: 0, sessionId, postingId: job.id, fitScore: outcome === "conflict" ? 62 : 86,
    confidence: outcome === "conflict" ? 78 : 72, rankingScore: outcome === "conflict" ? 65 : 82,
    outcomes: [{ requirementId: `${job.id}-requirement`, outcome, reasonCode: outcome === "conflict" ? "experience_conflict" : "missing_evidence" }],
    evidence: [], gaps: [{ requirementId: `${job.id}-requirement`, outcome, summary: outcome === "conflict" ? "经验年限明确冲突" : "经验信息未知" }],
    scoringVersion: "job-match-v1", profileRevision: 1, expectationRevision: 1,
    postingContentHash: job.contentHash, stale
  });
  return {
    id: sessionId, version: 3, state: "awaiting_job_selection", initialUrl: `${ats.baseUrl}/job-list.html`,
    scoringVersion: "job-match-v1", profileRevision: 1, expectationRevision: 1, executionEpoch: 1,
    createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z",
    source: "moka", adapterVersion: "moka-v1",
    expectation: { revision: 1, confirmedAt: "2026-08-16T00:00:00.000Z", criteria: [{ kind: "target_role", values: ["Java"], strength: "required" }] },
    postings: [recommended, conflict], results: [result("recommended-result", recommended, "unknown"), result("conflict-result", conflict, "conflict")],
    cursor: { value: "complete", pagesRead: 2, elapsedMs: 1200, newJobs: 2, consecutiveNoNewPages: 0, stopReason: "complete", updatedAt: "2026-08-16T00:00:00.000Z" }
  };
}
