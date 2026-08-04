import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import Fastify from "../../apps/api/node_modules/fastify/fastify.js";
import { createServer } from "../../apps/web/node_modules/vite/dist/node/index.js";
import { ActionPolicy } from "../../packages/action-policy/src/index.js";
import type { FieldDefinition } from "../../packages/form-semantics/src/index.js";
import { createRagService } from "../../packages/rag/src/index.js";
import { createApplicationService } from "../../apps/api/src/applications/application-service.js";
import { createApplicationTaskRepository } from "../../apps/api/src/applications/application-task-repository.js";
import { createCheckpointRepository } from "../../apps/api/src/applications/checkpoint-repository.js";
import { createFieldSemanticResolver } from "../../apps/api/src/applications/field-semantic-resolver.js";
import { registerApplicationRoutes } from "../../apps/api/src/applications/routes.js";
import { createTaskEventBus } from "../../apps/api/src/applications/task-events.js";
import { createSqliteDatabase } from "../../apps/api/src/db/client.js";
import { migrateDatabase } from "../../apps/api/src/db/migrate.js";
import { createProfileRepository } from "../../apps/api/src/profile/profile-repository.js";
import { createProductionFieldResolver, fieldPathForApplicationAnswer } from "../../apps/api/src/applications/production-field-resolver.js";
import { BrowserSessionManager } from "../../apps/browser-worker/src/session-manager.js";
import { startSyntheticAts } from "../../apps/synthetic-ats/src/server.js";

test("大疆风格字段完成精确填写、追问补全并停在提交前", async () => {
  const directory = await mkdtemp(join(tmpdir(), "resume-dji-coverage-"));
  const syntheticTaskId = randomUUID();
  const server = await startSyntheticAts();
  const database = createSqliteDatabase(":memory:");
  migrateDatabase(database);
  const profileRepository = createProfileRepository(database);
  const approvalKey = Buffer.alloc(32, 23);
  const policy = new ActionPolicy(approvalKey);
  const browser = new BrowserSessionManager({ profileDir: join(directory, "browser"), headless: true });
  await browser.start(approvalKey.toString("base64url"));
  const facts = [
    ["school", "education[0].institution", "测试大学"],
    ["project", "projects[0].name", "ApplyPilot"],
    ["award", "awards[0].level", "国家级"]
  ] as const;
  for (const [id, fieldPath, value] of facts) {
    profileRepository.createExtracted({
      id,
      fieldPath,
      value,
      status: "extracted",
      confidence: 1,
      scope: "profile",
      evidence: [{ documentId: "resume", page: 1, text: value, extraction: "pdf_text" }],
      revision: 1
    });
    profileRepository.confirm(id);
  }
  const embeddingProvider = {
    async embedDocuments() {
      return [[1, 0]];
    },
    async embedQuery(text: string) {
      if (text.includes("未命名字段")) throw new Error("no semantic match");
      return [0.89, Math.sqrt(1 - 0.89 ** 2)];
    }
  };
  const semanticDefinitions: FieldDefinition[] = [{
    semantic: "application.majorDirection",
    label: "专业方向",
    aliases: [],
    types: ["text"],
    sections: ["education"],
    risk: "normal",
    description: "候选人的学习或研究方向"
  }];
  const resolveField = createProductionFieldResolver({
    semanticResolver: createFieldSemanticResolver({ embeddingProvider, definitions: semanticDefinitions }),
    ragService: createRagService({ repository: profileRepository }),
    profileRepository
  });
  const djiUrl = "https://apply.careers.dji.com/campus-recruitment/dji/143359#/job/test/apply";
  const asDjiSnapshot = <T extends { url: string }>(snapshot: T): T => ({ ...snapshot, url: djiUrl });
  const service = createApplicationService({
    checkpoints: createCheckpointRepository(database),
    browser: {
      open: (taskId, url) => browser.open(taskId, url),
      observe: async (taskId) => asDjiSnapshot(await browser.observe(taskId)),
      execute: async (command, epoch) => {
        const result = await browser.execute(command, epoch);
        return { ...result, snapshot: asDjiSnapshot(result.snapshot) };
      }
    },
    resolveField,
    approve: (request, snapshot) => policy.approve(request, snapshot, { valid: snapshot.errors.length === 0 }).token,
    applyAnswers(taskId, answers, fields, questions = []) {
      for (const [fieldId, value] of Object.entries(answers)) {
        const field = fields.find((candidate) => candidate.id === fieldId);
        if (!field) throw new Error("answer_field_not_found");
        profileRepository.putTaskAnswer(taskId, fieldPathForApplicationAnswer(field, questions), value as string, [{
          documentId: "user", page: 1, text: String(value), extraction: "user"
        }]);
      }
    }
  });
  const app = Fastify();
  registerApplicationRoutes(app, {
    applicationService: service,
    taskEvents: createTaskEventBus(database),
    tasks: createApplicationTaskRepository(database),
    profileRepository
  });
  await app.ready();

  try {
    const applicationUrl = `${server.baseUrl}/dji?taskId=${encodeURIComponent(syntheticTaskId)}`;
    const created = await app.inject({ method: "POST", url: "/api/applications", payload: { applicationUrl } });
    expect(created.statusCode).toBe(201);
    const initialTask = created.json();
    expect(initialTask.state).toBe("needs_questions");
    expect(initialTask.fieldCoverage).toMatchObject({ missing: 1, review: 1, filled: 3 });
    expect(initialTask.fieldCoverage.fields).toContainEqual(expect.objectContaining({
      label: "毕业院校", status: "filled", source: "dji_catalog"
    }));
    expect(initialTask.fieldCoverage.fields).toContainEqual(expect.objectContaining({
      label: "研究方向", status: "review", confidence: 0
    }));
    expect(initialTask.fieldCoverage.fields).toContainEqual(expect.objectContaining({ label: "未命名字段", status: "missing" }));

    const initialSnapshot = await browser.observe(initialTask.id);
    expect(initialSnapshot.fields).toContainEqual(expect.objectContaining({ type: "select", currentValue: "国家级" }));
    expect(initialSnapshot.fields.some((field) => field.currentValue === "测试大学")).toBe(true);
    expect(initialSnapshot.fields.some((field) => field.currentValue === "ApplyPilot")).toBe(true);

    const answers = initialTask.questions.map((question: { id: string; label: string }) => ({
      id: question.id,
      value: question.label === "研究方向" ? "后端开发" : "用户补充信息",
      scope: "application",
      promoteToProfile: false
    }));
    const completed = await app.inject({
      method: "POST",
      url: `/api/applications/${initialTask.id}/commands`,
      payload: { type: "answer_questions", answers }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ state: "review_locked", fieldCoverage: { filled: 5, missing: 0, review: 0 } });

    const finalSnapshot = await browser.observe(initialTask.id);
    expect(finalSnapshot.fields.some((field) => field.currentValue === "用户补充信息")).toBe(true);
    expect(finalSnapshot.fields.some((field) => field.currentValue === "后端开发")).toBe(true);
    expect(finalSnapshot.actions.some((action) => action.class === "terminal_submit")).toBe(true);
    expect(server.state(syntheticTaskId)).toMatchObject({ submissionCount: 0 });
  } finally {
    await app.close();
    await browser.stop();
    await server.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("字段匹配面板在窄屏可展开且不暴露提交操作", async ({ page }) => {
  const taskId = randomUUID();
  const web = await createServer({
    root: fileURLToPath(new URL("../../apps/web", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "silent"
  });
  await web.listen();
  const address = web.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Web 测试服务器未启动");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const task = {
    id: taskId,
    applicationUrl: "https://apply.careers.dji.com/campus-recruitment/dji/143359#/job/test/apply",
    state: "needs_questions",
    commands: ["cancel", "open_browser", "answer_questions"],
    recoveryCommands: [],
    questions: [],
    taskAnswers: [],
    fieldCoverage: {
      total: 5, ready: 0, review: 1, missing: 1, unsupported: 0, filled: 3,
      fields: [
        assessment({ id: "school", label: "毕业院校" }, "ready", "dji_catalog", 1, "页面回读确认填写成功", "education[0].institution"),
        assessment({ id: "project", label: "项目名称" }, "ready", "dji_catalog", 1, "页面回读确认填写成功", "projects[0].name"),
        assessment({ id: "award", label: "获奖级别" }, "ready", "dji_catalog", 1, "页面回读确认填写成功", "awards[0].level"),
        assessment({ id: "major", label: "专业方向" }, "review", "semantic", 0.72, "存在多个语义接近的候选字段", "application.majorDirection"),
        assessment({ id: "unknown", label: "未命名字段" }, "missing", "none", 0, "档案中没有可安全使用的已确认资料")
      ].map((field) => field.status === "ready" ? { ...field, status: "filled" } : field)
    }
  };
  try {
    await page.route(`**/api/applications/${taskId}/events`, (route) => route.fulfill({
      status: 200, contentType: "text/event-stream", body: ": ready\n\n"
    }));
    await page.route(`**/api/applications/${taskId}`, (route) => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(task)
    }));
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(`${baseUrl}/applications/${taskId}`);

    await expect(page.getByRole("heading", { name: "字段匹配" })).toBeVisible();
    await page.getByRole("button", { name: "查看待处理字段" }).click();
    await expect(page.getByText("专业方向", { exact: true })).toBeVisible();
    await expect(page.getByText("未命名字段", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    await expect(page.getByRole("button", { name: /提交|发送申请/ })).toHaveCount(0);
  } finally {
    await web.close();
  }
});

function assessment(
  field: { id: string; label: string },
  status: "ready" | "review" | "missing" | "unsupported",
  source: "dji_catalog" | "semantic" | "user" | "none",
  confidence: number,
  reason: string,
  semantic?: string
) {
  return {
    fieldId: field.id,
    label: field.label,
    ...(semantic === undefined ? {} : { semantic }),
    status,
    source,
    confidence,
    reason,
    evidence: []
  };
}
