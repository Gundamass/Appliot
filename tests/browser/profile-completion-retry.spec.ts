import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ActionPolicy } from "../../packages/action-policy/src/index.js";
import { createApplicationService } from "../../apps/api/src/applications/application-service.js";
import { createCheckpointRepository } from "../../apps/api/src/applications/checkpoint-repository.js";
import { createTaskEventBus } from "../../apps/api/src/applications/task-events.js";
import { BrowserWorkerClient } from "../../apps/api/src/browser/worker-client.js";
import { createSqliteDatabase } from "../../apps/api/src/db/client.js";
import { migrateDatabase } from "../../apps/api/src/db/migrate.js";
import { createProfileRepository, type ProfileRepository } from "../../apps/api/src/profile/profile-repository.js";
import { startSyntheticAts } from "../../apps/synthetic-ats/src/server.js";

test("re-observes after profile completion and preserves existing values without submitting", async () => {
  const taskId = randomUUID();
  const profileDir = await mkdtemp(join(tmpdir(), "resume-profile-retry-"));
  const server = await startSyntheticAts();
  const database = createSqliteDatabase(":memory:");
  migrateDatabase(database);
  const profileRepository = createProfileRepository(database);
  const profileApi = await startProfileApi(profileRepository);
  const approvalKey = Buffer.alloc(32, 9);
  const policy = new ActionPolicy(approvalKey);
  const client = await BrowserWorkerClient.start({ profileDir, headless: true, approvalKey });
  const service = createApplicationService({
    checkpoints: createCheckpointRepository(database),
    taskEvents: createTaskEventBus(database),
    browser: {
      open: (taskId, url) => client.open(taskId, url),
      observe: async (taskId) => (await client.observe(taskId)).snapshot,
      execute: (command, executionEpoch) => client.execute(command, executionEpoch),
      invalidateExecution: (taskId, executionEpoch) => client.invalidateExecution(taskId, executionEpoch)
    },
    resolveField: async (taskId, field) => {
      if (field.label !== "城市") {
        return { status: "needs_question" as const, question: `请补充${field.label}` };
      }
      const fact = profileRepository.resolveForTask(taskId, "preferences.targetCity");
      return fact === undefined
        ? {
            status: "needs_question" as const,
            question: "请补充期望工作地点",
            fieldPath: "preferences.targetCity"
          }
        : {
            status: "verified" as const,
            value: fact.value,
            fieldPath: "preferences.targetCity"
          };
    },
    approve: (request, snapshot) => policy.approve(request, snapshot, { valid: snapshot.errors.length === 0 }).token
  });
  const applicationUrl = `${server.baseUrl}/application?taskId=${encodeURIComponent(taskId)}&scenario=profile-retry`;

  try {
    service.start({ taskId, applicationUrl });
    await service.openBrowser(taskId);
    await service.runUntilPause(taskId);
    expect(service.state(taskId).value).toBe("needs_questions");

    const before = (await client.observe(taskId)).snapshot;
    expect(before.fields.find((field) => field.label === "姓名")?.currentValue).toBe("已有姓名");
    expect(before.fields.find((field) => field.label === "城市")?.currentValue).toBe("");

    const profileResponse = await fetch(`${profileApi.baseUrl}/api/profile/facts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fieldPath: "preferences.targetCity", value: "杭州" })
    });
    expect(profileResponse.status).toBe(200);

    await service.resumeWithProfile(taskId);
    expect(service.state(taskId).value).toBe("review_locked");

    const after = (await client.observe(taskId)).snapshot;
    expect(after.fields.find((field) => field.label === "姓名")?.currentValue).toBe("已有姓名");
    expect(after.fields.find((field) => field.label === "城市")?.currentValue).toBe("hangzhou");
    expect(server.state(taskId).submissionCount).toBe(0);
  } finally {
    await profileApi.close();
    await client.stop();
    await server.close();
    database.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});

async function startProfileApi(profileRepository: ProfileRepository): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/api/profile/facts") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const fact = profileRepository.upsertUserFact(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(fact));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("档案测试 API 没有分配端口");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}
