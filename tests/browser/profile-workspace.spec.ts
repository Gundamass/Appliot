import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "../../apps/web/node_modules/vite/dist/node/index.js";

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
  if (!address || typeof address === "string") throw new Error("Web 测试服务未启动");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server.close();
});

test("候选人工作区在桌面和手机端保持可读且聚焦缺失字段", async ({ page }) => {
  await mockProfile(page);

  for (const viewport of [
    { width: 1280, height: 900, name: "desktop" },
    { width: 390, height: 844, name: "mobile" }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${baseUrl}/?view=profile`);

    await expect(page.getByRole("heading", { name: "我的简历", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "候选人工作台" }).locator(".workspace-conversation-home, :scope > button")).toHaveText([
      "对话首页",
      "投递进度",
      "我的简历"
    ]);
    await expect(page.getByRole("button", { name: "简历解析", exact: true })).toHaveCount(1);
    const accessibilityHeading = page.getByRole("heading", { name: "简历资料", exact: true });
    await expect(accessibilityHeading).toHaveCSS("position", "absolute");
    await expect(accessibilityHeading).toHaveCSS("width", "1px");
    await expect(page.getByRole("button", { name: "自我评价审核" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "字段检索" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "档案全局信息" })).toContainText("何庆");

    await page.getByRole("button", { name: "补全资料" }).click();
    await expect(page.getByLabel("期望工作地点")).toBeFocused();
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await page.screenshot({ path: `playwright-artifacts/profile-workspace-${viewport.name}.png`, fullPage: true });
  }
});

async function mockProfile(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/profile/facts", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([{
      id: "profile-name",
      fieldPath: "basics.name",
      value: "何庆",
      status: "user_confirmed",
      confidence: 1,
      scope: "profile",
      evidence: [{ documentId: "user", page: 1, text: "何庆", extraction: "user" }],
      revision: 1
    }])
  }));
  await page.route("**/api/profile/completeness", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      completed: 1,
      total: 2,
      sections: [
        { id: "basics", label: "基本信息", completed: 1, total: 1, missing: [] },
        { id: "preferences", label: "求职偏好", completed: 0, total: 1, missing: ["preferences.targetCity"] }
      ]
    })
  }));
  await page.route("**/api/profile/documents/latest", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ document: null })
  }));
}

async function hasHorizontalOverflow(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}
