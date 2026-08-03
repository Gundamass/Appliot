import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionPolicy } from "../../packages/action-policy/src/index.js";
import type { PageAction } from "../../packages/contracts/src/browser.js";
import { startSyntheticAts } from "../../apps/synthetic-ats/src/server.js";
import { createApplicationService } from "../../apps/api/src/applications/application-service.js";
import { createCheckpointRepository } from "../../apps/api/src/applications/checkpoint-repository.js";
import { BrowserWorkerClient } from "../../apps/api/src/browser/worker-client.js";
import { createSqliteDatabase } from "../../apps/api/src/db/client.js";
import { migrateDatabase } from "../../apps/api/src/db/migrate.js";

export async function createControlledApplicationHarness(scenario = "default") {
  const taskId = randomUUID();
  const profileDir = await mkdtemp(join(tmpdir(), "resume-e2e-browser-"));
  const server = await startSyntheticAts();
  const database = createSqliteDatabase(":memory:");
  migrateDatabase(database);
  const approvalKey = Buffer.alloc(32, 8);
  const policy = new ActionPolicy(approvalKey);
  const client = await BrowserWorkerClient.start({ profileDir, headless: true, approvalKey });
  const applicationUrl = `${server.baseUrl}/application?taskId=${encodeURIComponent(taskId)}&scenario=${encodeURIComponent(scenario)}`;
  await client.open(taskId, applicationUrl);
  let reviewSnapshot: Awaited<ReturnType<BrowserWorkerClient["observe"]>>["snapshot"] | undefined;
  const service = createApplicationService({
    checkpoints: createCheckpointRepository(database),
    browser: {
      observe: async (id) => (await client.observe(id)).snapshot,
      execute: (command) => client.execute(command)
    },
    resolveField: async (_id, field) => {
      const values: Record<string, unknown> = {
        "邮箱": "me@example.com",
        "城市": "杭州",
        "自我评价": "具备扎实的 Java 后端开发能力"
      };
      return field.label in values
        ? { status: "verified" as const, value: values[field.label] }
        : { status: "needs_question" as const, question: `请补充${field.label}` };
    },
    approve: (request, snapshot) => policy.approve(request, snapshot, {
      valid: snapshot.errors.length === 0
    }).token
  });
  service.start({
    taskId,
    applicationUrl
  });

  return {
    async runToReview(): Promise<void> {
      for (let step = 0; step < 5 && service.state(taskId).value !== "review_locked"; step += 1) {
        await service.runUntilPause(taskId);
      }
      if (service.state(taskId).value !== "review_locked") {
        throw new Error(`未到达审核锁：${String(service.state(taskId).value)}`);
      }
    },
    async runUntilStopped(): Promise<void> {
      for (let step = 0; step < 5 && service.state(taskId).value !== "failed"; step += 1) {
        await service.runUntilPause(taskId);
      }
    },
    applicationState: () => service.state(taskId).value,
    serverState: async () => {
      const response = await fetch(`${server.baseUrl}/api/state?taskId=${encodeURIComponent(taskId)}`);
      return response.json() as Promise<{ draft: Record<string, string>; submissionCount: number }>;
    },
    async terminalActions(): Promise<PageAction[]> {
      reviewSnapshot = (await client.observe(taskId)).snapshot;
      return reviewSnapshot.actions.filter((action) => action.class === "terminal_submit");
    },
    requestClick: (actionId: string) => service.requestIntermediateClick(taskId, actionId),
    approveTerminalAction(actionId: string) {
      if (!reviewSnapshot) throw new Error("尚未观察审核页");
      return policy.approve({
        taskId,
        snapshotId: reviewSnapshot.id,
        targetId: actionId,
        operation: "click_intermediate"
      }, reviewSnapshot);
    },
    async close(): Promise<void> {
      await client.stop();
      await server.close();
      database.close();
      await rm(profileDir, { recursive: true, force: true });
    }
  };
}
