import { expect, test } from "@playwright/test";
import type { ApplicationService } from "../../apps/api/src/applications/application-service.js";
import { createApplicationTaskRepository } from "../../apps/api/src/applications/application-task-repository.js";
import {
  deterministicApplicationTaskId,
  prepareApplicationTarget
} from "../../apps/api/src/applications/application-target.js";
import { createTaskEventBus } from "../../apps/api/src/applications/task-events.js";
import { createFullStackWebHarness } from "./test-harness.js";

const polluted = "https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440%E8%BF%99%E4%B8%AA%E9%A1%B5%E9%9D%A2%E5%8F%AF%E4%BB%A5%E6%8A%95%E9%80%92%E5%90%97";
const clean = "https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440";
const legacyTaskId = "a0b682fc-7d1d-5b39-b090-1efa4d8bca42";

test("浏览器、API、数据库和任务页共享清洗后的确定性投递目标", async ({ page }) => {
  const starts: Array<{ taskId: string; applicationUrl: string }> = [];
  const browserTargets: Array<{ taskId: string; applicationUrl: string }> = [];
  let submissionCount = 0;
  const harness = await createFullStackWebHarness({
    configure(dependencies) {
      const tasks = createApplicationTaskRepository(dependencies.database);
      tasks.createFromJob({
        id: legacyTaskId,
        name: "历史失败任务",
        applicationUrl: "https://legacy.example.com/form?keep=unchanged"
      });
      dependencies.taskEvents = createTaskEventBus(dependencies.database);
      dependencies.prepareApplicationTarget = (rawUrl, identity) =>
        prepareApplicationTarget(rawUrl, identity, async () => ["220.181.7.203"]);
      dependencies.applicationService = {
        activeBrowserTaskId: () => undefined,
        start(input: { taskId: string; applicationUrl: string }) {
          starts.push(input);
        },
        async openBrowser(taskId: string) {
          browserTargets.push({ taskId, applicationUrl: tasks.get(taskId)!.applicationUrl });
        },
        async runUntilPause() {},
        state: () => ({ value: "observing_page", context: { questions: [] } }),
        contentReview: () => undefined,
        adapterReview: () => undefined,
        fieldCoverage: () => undefined,
        progress: () => ({}),
        requiresRecovery: () => false,
        recoveryCommands: () => [],
        async cancel() {},
        async dispose() {},
        submissionCount: () => submissionCount
      } as unknown as ApplicationService;
    }
  });
  try {
    const legacyBefore = row(harness, "SELECT * FROM application_tasks WHERE id = ?", legacyTaskId);
    await page.goto(harness.webBaseUrl);

    const first = await createThroughBrowser(page, polluted);
    const expectedId = deterministicApplicationTaskId("direct", clean);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ id: expectedId, applicationUrl: clean });
    expect(row(harness, "SELECT id, application_url FROM application_tasks WHERE id = ?", expectedId)).toEqual({
      id: expectedId,
      application_url: clean
    });
    expect(starts).toEqual([{ taskId: expectedId, applicationUrl: clean }]);
    expect(browserTargets).toEqual([{ taskId: expectedId, applicationUrl: clean }]);

    await page.goto(`${harness.webBaseUrl}/applications/${expectedId}`);
    await expect(page.getByRole("link", { name: "查看目标页面" })).toHaveAttribute("href", clean);

    const replay = await createThroughBrowser(page, clean);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: expectedId, applicationUrl: clean });
    expect(starts).toHaveLength(1);
    expect(browserTargets).toHaveLength(1);
    expect(row(harness, "SELECT COUNT(*) AS count FROM application_tasks WHERE id = ?", expectedId)).toEqual({ count: 1 });
    expect(row(harness, "SELECT * FROM application_tasks WHERE id = ?", legacyTaskId)).toEqual(legacyBefore);
    expect(submissionCount).toBe(0);
  } finally {
    submissionCount = 0;
    await harness.close();
  }
});

async function createThroughBrowser(page: import("@playwright/test").Page, applicationUrl: string) {
  return page.evaluate(async (url) => {
    const response = await fetch("/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ applicationUrl: url })
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, applicationUrl);
}

function row(
  harness: Awaited<ReturnType<typeof createFullStackWebHarness>>,
  sql: string,
  ...parameters: unknown[]
): unknown {
  return harness.database.prepare(sql).get(...parameters);
}
