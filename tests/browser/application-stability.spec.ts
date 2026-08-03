import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { ActionPolicy } from "../../packages/action-policy/src/index.js";
import type { ExecutableCommand, WorkerActivity } from "../../packages/contracts/src/browser.js";
import { createApplicationService } from "../../apps/api/src/applications/application-service.js";
import { createCheckpointRepository } from "../../apps/api/src/applications/checkpoint-repository.js";
import { createSqliteDatabase } from "../../apps/api/src/db/client.js";
import { migrateDatabase } from "../../apps/api/src/db/migrate.js";
import { ActivityMonitor } from "../../apps/browser-worker/src/activity-monitor.js";
import { ControlledExecutor } from "../../apps/browser-worker/src/executor.js";
import { BrowserObserver } from "../../apps/browser-worker/src/observer.js";
import { startSyntheticAts, type SyntheticTaskState } from "../../apps/synthetic-ats/src/server.js";

test("detects manual job selection and login before reaching the review lock", async ({ page }) => {
  const harness = await createStabilityHarness(page, "onboarding");
  try {
    await page.goto(harness.url("/jobs"));
    await page.getByRole("button", { name: "Java 后端开发工程师" }).click();
    await expect(page).toHaveURL(/\/login/u);
    await harness.begin();
    await expect.poll(() => harness.applicationState()).toBe("awaiting_login");

    await page.locator("#password").fill("synthetic-password");
    await page.getByRole("button", { name: "登录并继续" }).click();
    await expect(page).toHaveURL(/\/application/u);
    await expect.poll(() => harness.applicationState(), { timeout: 10_000 }).toBe("review_locked");

    expect(await harness.serverState()).toMatchObject({
      selectedJob: "java-backend",
      loginCount: 1,
      submissionCount: 0
    });
  } finally {
    await harness.close();
  }
});

test("resumes only after manual input passes a safe readback and deduplicates fingerprints", async ({ page }) => {
  const harness = await createStabilityHarness(page, "manual-readback");
  try {
    await page.goto(harness.url("/application"));
    await expect.poll(() => harness.activities().filter((event) => event.type === "page_stable").length)
      .toBeGreaterThan(0);
    const run = harness.begin();
    await harness.waitForManualTakeover();
    await page.getByLabel("邮箱").fill("invalid-email");

    await expect.poll(() => harness.progress().status).toBe("paused");
    await expect(page.getByRole("alert")).toContainText("邮箱格式不正确");
    expect(harness.applicationState()).not.toBe("review_locked");

    await expect.poll(() => harness.activities().filter((event) => event.type === "page_stable").length)
      .toBeGreaterThan(1);
    const stableEventsBefore = harness.activities().filter((event) => event.type === "page_stable").length;
    const modelCallsBefore = (await harness.serverState()).modelCallCount;
    await page.evaluate(() => {
      document.querySelector("main")?.setAttribute("data-layout-tick", "1");
      document.querySelector("main")?.setAttribute("data-layout-tick", "2");
    });
    await page.waitForTimeout(1_500);
    expect(harness.activities().filter((event) => event.type === "page_stable")).toHaveLength(stableEventsBefore);
    expect((await harness.serverState()).modelCallCount).toBe(modelCallsBefore);

    await page.getByLabel("邮箱").fill("manual@example.com");
    await expect.poll(() => harness.applicationState(), { timeout: 10_000 }).toBe("review_locked");
    await run;
    expect(await harness.serverState()).toMatchObject({
      draft: { email: "manual@example.com" },
      submissionCount: 0
    });
  } finally {
    await harness.close();
  }
});

test("turns a stuck control into a recovery pause and continues after manual repair", async ({ page }) => {
  const harness = await createStabilityHarness(page, "stuck-control", { stuckControl: true });
  try {
    await page.goto(harness.url("/application"));
    const run = harness.begin();

    await expect.poll(() => harness.progress(), { timeout: 35_000 }).toMatchObject({
      status: "paused",
      busy: false,
      recovery: ["retry_current", "manual_done", "cancel"],
      lastResult: { operation: { status: "timed_out", errorCode: "TIMEOUT" } }
    });
    expect(harness.stuckAttempts()).toBe(2);

    await page.getByLabel("手机号码").fill("13800138000");
    await expect.poll(() => harness.applicationState(), { timeout: 10_000 }).toBe("review_locked");
    await run;
    expect(await harness.serverState()).toMatchObject({
      draft: { phone: "13800138000" },
      submissionCount: 0
    });
  } finally {
    await harness.close();
  }
});

type Scenario = "onboarding" | "manual-readback" | "stuck-control";

async function createStabilityHarness(page: Page, scenario: Scenario, options: { stuckControl?: boolean } = {}) {
  const taskId = randomUUID();
  const server = await startSyntheticAts();
  const database = createSqliteDatabase(":memory:");
  migrateDatabase(database);
  const approvalKey = Buffer.alloc(32, 9);
  const policy = new ActionPolicy(approvalKey);
  const observer = new BrowserObserver(page);
  const monitor = new ActivityMonitor(page, { readStructure: () => observer.observeStructure() });
  const executor = new ControlledExecutor(observer, approvalKey, undefined, monitor);
  const activities: WorkerActivity[] = [];
  const resolvedFields = new Map<string, unknown>();
  monitor.subscribe((activity) => activities.push(activity));
  let stuckAttempts = 0;
  let manualTakeoverStarted = false;
  let notifyManualTakeover: (() => void) | undefined;
  const manualTakeoverReady = new Promise<void>((resolve) => {
    notifyManualTakeover = resolve;
  });

  const execute = async (command: ExecutableCommand) => {
    if (scenario === "manual-readback" && command.type === "fill" && !manualTakeoverStarted) {
      manualTakeoverStarted = true;
      notifyManualTakeover?.();
      return new Promise<Awaited<ReturnType<ControlledExecutor["execute"]>>>(() => undefined);
    }
    if (options.stuckControl && command.type === "fill" && command.value === resolvedFields.get("手机号码")) {
      stuckAttempts += 1;
      return new Promise<Awaited<ReturnType<ControlledExecutor["execute"]>>>(() => undefined);
    }
    return executor.execute(command);
  };
  const service = createApplicationService({
    checkpoints: createCheckpointRepository(database),
    browser: {
      observe: async (id) => executor.observe(id),
      execute,
      onActivity: (listener) => monitor.subscribe(listener)
    },
    resolveField: async (_id, field) => {
      if (resolvedFields.has(field.label)) {
        return { status: "verified" as const, value: resolvedFields.get(field.label) };
      }
      const response = await fetch(`${server.baseUrl}/api/model-call?taskId=${encodeURIComponent(taskId)}`, {
        method: "POST"
      });
      if (!response.ok) throw new Error("合成站模型计数不可用");
      const values: Record<string, unknown> = {
        "邮箱": "agent@example.com",
        "城市": "杭州",
        "手机号码": "13900000000",
        "自我评价": "具备扎实的 Java 后端开发能力"
      };
      const value = values[field.label] ?? "已确认";
      resolvedFields.set(field.label, value);
      return { status: "verified" as const, value };
    },
    approve: (request, snapshot) => policy.approve(request, snapshot, {
      valid: snapshot.errors.length === 0
    }).token
  });
  service.start({ taskId, applicationUrl: `${server.baseUrl}/application` });
  await monitor.start(taskId);

  return {
    url(pathname: string) {
      return `${server.baseUrl}${pathname}?taskId=${encodeURIComponent(taskId)}&scenario=${scenario}`;
    },
    applicationState: () => service.state(taskId).value,
    begin: () => service.runUntilPause(taskId),
    waitForManualTakeover: () => manualTakeoverReady,
    progress: () => service.progress(taskId),
    stuckAttempts: () => stuckAttempts,
    activities: () => [...activities],
    async serverState() {
      const response = await fetch(`${server.baseUrl}/api/state?taskId=${encodeURIComponent(taskId)}`);
      return response.json() as Promise<SyntheticTaskState>;
    },
    async close() {
      monitor.stop();
      await server.close();
      database.close();
    }
  };
}
