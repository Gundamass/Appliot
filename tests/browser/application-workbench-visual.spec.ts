import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "../../apps/web/node_modules/vite/dist/node/index.js";

const taskId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const viewports = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "tablet", width: 768, height: 900 },
  { name: "mobile", width: 320, height: 800 }
] as const;

const stages = ["等待表单", "确定性填写", "语义补全", "回读校验", "最终审核"] as const;
const terminalButtonName = /^(?:提交(?:申请|简历)?|投递(?:申请|简历)?|发送(?:申请|简历)?|确认(?:申请|投递)|确认并(?:提交|投递)|完成申请|立即申请|预览并提交)$/u;

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

for (const viewport of viewports) {
  test(`投递工作台在 ${viewport.width}px 视口下保持可用布局`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockTask(page);
    await page.goto(`${baseUrl}/applications/${taskId}`);

    await expect(page.getByRole("heading", { name: "投递任务工作台" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "候选人工作台" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "候选人工作台" })
      .getByRole("button", { name: "投递审核", exact: true }))
      .toHaveAttribute("aria-current", "page");

    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.viewportWidth);

    const layout = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>(".profile-workspace");
      const sidebar = document.querySelector<HTMLElement>(".workspace-sidebar");
      const navigation = document.querySelector<HTMLElement>(".workspace-navigation");
      const workspace = document.querySelector<HTMLElement>(".task-workbench-grid");
      if (!shell || !sidebar || !navigation || !workspace) throw new Error("工作台布局节点缺失");
      return {
        shellDisplay: getComputedStyle(shell).display,
        sidebarWidth: sidebar.getBoundingClientRect().width,
        navigationOverflowX: getComputedStyle(navigation).overflowX,
        workspaceColumns: getComputedStyle(workspace).gridTemplateColumns
      };
    });

    if (viewport.name === "desktop") {
      expect(layout.shellDisplay).toBe("grid");
      expect(layout.sidebarWidth).toBeGreaterThanOrEqual(220);
      expect(layout.workspaceColumns.split(" ")).toHaveLength(2);
    } else if (viewport.name === "tablet") {
      expect(layout.shellDisplay).toBe("grid");
      expect(layout.workspaceColumns.split(" ")).toHaveLength(1);
    } else {
      expect(layout.shellDisplay).toBe("block");
      expect(layout.sidebarWidth).toBeLessThanOrEqual(viewport.width);
      expect(["auto", "scroll"]).toContain(layout.navigationOverflowX);
      expect(layout.workspaceColumns.split(" ")).toHaveLength(1);
    }

    for (const stage of stages) {
      await expect(page.getByText(stage, { exact: true })).toBeVisible();
    }
    await expect(page.getByText("尝试 1/2", { exact: true })).toBeVisible();
    await expect(page.getByLabel("填写统计")).toContainText("精确 5");
    await expect(page.getByLabel("填写统计")).toContainText("语义 2");
    const fieldDetails = page.getByLabel("查看填写明细");
    await expect(fieldDetails).toBeVisible();
    await expect(fieldDetails).not.toHaveAttribute("open");
    await fieldDetails.locator("summary").click();
    await expect(page.getByRole("heading", { name: "字段填写明细" })).toBeVisible();
    await expect(page.getByText("风险聚焦", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "需要你处理" })).toBeVisible();
    await expect(page.locator(".task-attention-list").getByRole("button", { name: /可入职时间/u })).toBeVisible();

    await expect(page.getByRole("button", { name: terminalButtonName })).toHaveCount(0);

    const screenshot = await page.screenshot({
      path: `playwright-artifacts/application-workbench-${viewport.name}.png`,
      fullPage: true
    });
    expect(screenshot.byteLength).toBeGreaterThan(0);
  });
}

async function mockTask(page: Page): Promise<void> {
  await page.route(`**/api/applications/${taskId}/events`, (route) => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: ": ready\n\n"
  }));
  await page.route(`**/api/applications/${taskId}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      id: taskId,
      applicationUrl: "https://career.example.com/jobs/42",
      state: "needs_questions",
      executionProgress: {
        currentPhase: "semantic_fill",
        phases: [
          { phase: "waiting_for_form", status: "completed" },
          { phase: "deterministic_fill", status: "completed" },
          { phase: "semantic_fill", status: "running" },
          { phase: "readback_validation", status: "pending" },
          { phase: "final_review", status: "pending" }
        ],
        current: { action: "正在选择：本科专业", fieldId: "major", attempt: 1, maxAttempts: 2 },
        counts: { exact: 5, semantic: 2, user: 1, missing: 1, failed: 0 }
      },
      fieldCoverage: {
        total: 2,
        ready: 0,
        review: 1,
        missing: 0,
        failed: 0,
        unsupported: 0,
        filled: 1,
        fields: [
          {
            fieldId: "name",
            label: "姓名",
            semantic: "basics.name",
            status: "filled",
            source: "exact",
            confidence: 1,
            reason: "页面回读确认填写成功",
            evidence: []
          },
          {
            fieldId: "major",
            label: "本科专业",
            semantic: "education[0].major",
            status: "review",
            source: "semantic",
            confidence: 0.86,
            reason: "语义匹配后等待最终审核",
            evidence: []
          }
        ]
      },
      commands: ["cancel", "open_browser", "answer_questions"],
      questions: [
        {
          id: "date",
          fieldId: "date",
          fieldPath: "preferences.availableDate",
          label: "可入职时间",
          text: "请确认可入职时间",
          inputType: "date",
          options: [],
          required: true
        },
        {
          id: "travel",
          fieldId: "travel",
          fieldPath: "preferences.travel",
          label: "接受出差",
          text: "是否接受出差",
          inputType: "checkbox",
          options: [],
          required: false
        }
      ],
      taskAnswers: []
    })
  }));
}
