import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ActionPolicy } from "../../packages/action-policy/src/index.js";
import { createRagService } from "../../packages/rag/src/index.js";
import { createApplicationService } from "../../apps/api/src/applications/application-service.js";
import { createCheckpointRepository } from "../../apps/api/src/applications/checkpoint-repository.js";
import { planRepeatedSectionActions } from "../../apps/api/src/applications/repeated-section-planner.js";
import { createSqliteDatabase } from "../../apps/api/src/db/client.js";
import { migrateDatabase } from "../../apps/api/src/db/migrate.js";
import { createProfileRepository } from "../../apps/api/src/profile/profile-repository.js";
import { BrowserSessionManager } from "../../apps/browser-worker/src/session-manager.js";
import { startSyntheticAts } from "../../apps/synthetic-ats/src/server.js";

test("uploads PDF, fills Mokahr experience sections from production RAG, and never submits", async () => {
  const taskId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), "resume-mokahr-e2e-"));
  const resumePath = join(directory, "resume.pdf");
  await writeFile(resumePath, "%PDF-1.4 fixture", "utf8");
  const server = await startSyntheticAts();
  const database = createSqliteDatabase(":memory:");
  migrateDatabase(database);
  const repository = createProfileRepository(database);
  const facts = [
    ["phone", "basics.phone", "13800138000"],
    ["employment-type", "work[0].employmentType", "Java 后端实习"],
    ["company", "work[0].company", "测试科技"],
    ["title", "work[0].title", "Java 后端实习"],
    ["project-name", "projects[0].name", "ApplyPilot"],
    ["project-description", "projects[0].description", "受控浏览器简历投递助手"]
  ] as const;
  for (const [id, fieldPath, value] of facts) {
    repository.createExtracted({ id, fieldPath, value, status: "extracted", confidence: 1, scope: "profile", evidence: [{ documentId: "resume", page: 1, text: value, extraction: "pdf_text" }], revision: 1 });
    repository.confirm(id);
  }
  const rag = createRagService({ repository });
  const key = Buffer.alloc(32, 17);
  const policy = new ActionPolicy(key);
  const browser = new BrowserSessionManager({ profileDir: join(directory, "profile"), headless: true, fileResolver: async () => resumePath });
  await browser.start(key.toString("base64url"));
  const checkpoints = createCheckpointRepository(database);
  const service = createApplicationService({
    checkpoints,
    browser: { observe: (id) => browser.observe(id), execute: (command, epoch) => browser.execute(command, epoch) },
    async resolveField(id, field) {
      const semantic = field.semanticHint?.includes(".") ? field.semanticHint : `application.${field.semanticHint || "jobSpecific"}`;
      const decision = await rag.resolveField({ taskId: id, fieldId: field.id, semantic, label: field.label, type: field.type === "textarea" ? "textarea" : "text", validators: field.required ? ["required"] : [] });
      return {
        status: decision.status === "verified_auto" || decision.status === "needs_review" ? "verified" : decision.status,
        fieldPath: semantic,
        assessment: {
          fieldId: field.id,
          label: field.label,
          semantic,
          status: decision.status === "verified_auto" ? "ready" as const : decision.status === "needs_review" ? "review" as const : "missing" as const,
          source: "exact" as const,
          confidence: decision.confidence,
          reason: decision.status === "verified_auto" ? "字段映射和资料值均已通过验证" : "字段需要进一步确认",
          evidence: decision.evidence
        },
        ...(decision.value === undefined ? {} : { value: decision.value }),
        ...(decision.question === undefined ? {} : { question: decision.question })
      };
    },
    approve: (request, snapshot) => policy.approve(request, snapshot, { valid: snapshot.errors.length === 0 }).token,
    resolveFileId: () => "resume.pdf",
    listProfileFacts: () => repository.listActive()
  });
  try {
    const url = `${server.baseUrl}/mokahr?taskId=${encodeURIComponent(taskId)}`;
    service.start({ taskId, applicationUrl: url });
    await browser.open(taskId, url);
    await service.runUntilPause(taskId);

    const machineState = service.state(taskId);
    const checkpoint = checkpoints.latest(taskId);
    expect(machineState.value, JSON.stringify({
      context: machineState.context,
      remote: server.state(taskId),
      snapshot: checkpoint?.snapshot,
      repeatedSectionPlans: checkpoint?.snapshot
        ? planRepeatedSectionActions(checkpoint.snapshot, repository.listActive())
        : []
    }, null, 2)).toBe("review_locked");
    expect(service.fieldCoverage(taskId)).toMatchObject({ missing: 0, review: 0, filled: 7 });
    expect(server.state(taskId)).toMatchObject({
      uploadCount: 1,
      submissionCount: 0,
      draft: { email: "parsed@example.com", phone: "13800138000", school: "测试大学", company: "测试科技", position: "Java 后端实习", projectName: "ApplyPilot", projectDescription: "受控浏览器简历投递助手" }
    });
  } finally {
    await browser.stop();
    await server.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
