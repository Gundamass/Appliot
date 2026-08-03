import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "../../apps/web/node_modules/vite/dist/node/index.js";

const taskId = "0f8fad5b-d9cb-469f-a165-70867728950e";
let server: ViteDevServer;
let baseUrl: string;

test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../apps/web", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "silent"
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Web 测试服务器未启动");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server.close();
});

test("聚合追问在桌面端无横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockTask(page, {
    id: taskId,
    applicationUrl: "https://career.example.com/jobs/42",
    state: "needs_questions",
    commands: ["cancel", "open_browser", "answer_questions"],
    questions: [
      { id: "date", fieldId: "date", fieldPath: "preferences.availableDate", label: "可入职时间", text: "请确认可入职时间", inputType: "date", options: [], required: true },
      { id: "travel", fieldId: "travel", fieldPath: "preferences.travel", label: "接受出差", text: "是否接受出差", inputType: "checkbox", options: [], required: false }
    ],
    taskAnswers: []
  });

  await page.goto(`${baseUrl}/applications/${taskId}`);
  await expect(page.getByRole("heading", { name: "补充当前页面信息" })).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(false);
  await page.screenshot({ path: "playwright-artifacts/application-questions-desktop.png", fullPage: true });
});

test("内容审核在移动端折叠为单列且不暴露提交", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockTask(page, {
    id: taskId,
    applicationUrl: "https://career.example.com/jobs/42",
    state: "awaiting_content_review",
    commands: ["cancel", "open_browser", "approve_content", "reject_content"],
    questions: [],
    taskAnswers: [],
    contentReview: {
      id: "review-1",
      fieldId: "self",
      fieldLabel: "自我评价",
      original: "具备扎实的 Java 后端基础，参与过真实项目交付。",
      draft: "具备扎实的 Java 后端基础，并拥有与目标岗位相关的项目交付经验。",
      reasons: ["突出目标岗位关注的后端交付经验"],
      evidence: [{ documentId: "resume", page: 1, text: "负责 Java 后端开发和接口交付", extraction: "pdf_text" }],
      unsupportedClaims: [],
      status: "needs_review"
    }
  });

  await page.goto(`${baseUrl}/applications/${taskId}`);
  await expect(page.getByRole("heading", { name: "审核自我评价" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(?:提交(?:申请|简历)?|投递(?:申请|简历)?|发送(?:申请|简历)?|确认(?:申请|投递)|完成申请|立即申请)$/ })).toHaveCount(0);
  expect(await horizontalOverflow(page)).toBe(false);
  await page.screenshot({ path: "playwright-artifacts/application-review-mobile.png", fullPage: true });
});

async function mockTask(page: import("@playwright/test").Page, task: object): Promise<void> {
  await page.route(`**/api/applications/${taskId}/events`, (route) => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: ": ready\n\n"
  }));
  await page.route(`**/api/applications/${taskId}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(task) });
  });
}

async function horizontalOverflow(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}
