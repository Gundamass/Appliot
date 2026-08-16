import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ActionPolicy } from "../../packages/action-policy/src/index.js";
import { createRagService } from "../../packages/rag/src/index.js";
import { createApplicationService } from "../../apps/api/src/applications/application-service.js";
import { createCheckpointRepository } from "../../apps/api/src/applications/checkpoint-repository.js";
import { createFieldSemanticResolver } from "../../apps/api/src/applications/field-semantic-resolver.js";
import { createProductionFieldResolver } from "../../apps/api/src/applications/production-field-resolver.js";
import { createSqliteDatabase } from "../../apps/api/src/db/client.js";
import { migrateDatabase } from "../../apps/api/src/db/migrate.js";
import { createProfileRepository } from "../../apps/api/src/profile/profile-repository.js";
import { ControlledExecutor } from "../../apps/browser-worker/src/executor.js";
import { BrowserObserver } from "../../apps/browser-worker/src/observer.js";
import { startSyntheticAts } from "../../apps/synthetic-ats/src/server.js";

test("国内 ATS 稳定填写完整档案并停在最终审核", async ({ page }) => {
  const taskId = randomUUID();
  const server = await startSyntheticAts();
  const database = createSqliteDatabase(":memory:");
  migrateDatabase(database);
  const profileRepository = createProfileRepository(database);
  const facts = [
    ["school", "education[0].institution", "测试大学"],
    ["major", "education[0].major", "软件工程专业"],
    ["internship-company", "work[0].company", "星云科技"],
    ["internship-title", "work[0].title", "Java 后端实习"],
    ["internship-type", "work[0].employmentType", "实习"],
    ["project-0-name", "projects[0].name", "ApplyPilot"],
    ["project-0-description", "projects[0].description", "受控浏览器简历投递助手"],
    ["project-0-start", "projects[0].startDate", "2022-10"],
    ["project-1-name", "projects[1].name", "CodeGraph Lab"],
    ["project-1-description", "projects[1].description", "代码关系分析工具"],
    ["project-1-start", "projects[1].startDate", "2023-03"],
    ["award-name", "awards[0].name", "全国大学生软件测试大赛"],
    ["award-date", "awards[0].date", "2023-11"],
    ["language-name", "languages[0].name", "英语"],
    ["language-proficiency", "languages[0].proficiency", "熟练"],
    ["language-speaking", "languages[0].speakingListening", "熟练"],
    ["language-writing", "languages[0].readingWriting", "熟练"],
    ["wechat", "basics.wechat", "档案微信号"]
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

  const approvalKey = Buffer.alloc(32, 31);
  const observer = new BrowserObserver(page);
  const executor = new ControlledExecutor(observer, approvalKey);
  const policy = new ActionPolicy(approvalKey);
  const resolveField = createProductionFieldResolver({
    semanticResolver: createFieldSemanticResolver(),
    ragService: createRagService({ repository: profileRepository }),
    profileRepository
  });
  const executionResults: Array<{
    command: string;
    fieldId?: string;
    value?: string;
    status: string;
    errors: string[];
  }> = [];
  const service = createApplicationService({
    checkpoints: createCheckpointRepository(database),
    browser: {
      observe: (id) => executor.observe(id),
      execute: async (command) => {
        const result = await executor.execute(command);
        executionResults.push({
          command: command.type,
          ...("fieldId" in command ? { fieldId: command.fieldId } : {}),
          ...("value" in command ? { value: String(command.value) } : {}),
          status: result.status,
          errors: result.errors
        });
        return result;
      }
    },
    resolveField,
    approve: (request, snapshot) => policy.approve(request, snapshot, {
      valid: snapshot.errors.length === 0
    }).token,
    listProfileFacts: () => profileRepository.listActive()
  });

  try {
    const url = `${server.baseUrl}/stability?taskId=${encodeURIComponent(taskId)}`;
    await page.goto(url);
    service.start({ taskId, applicationUrl: url });
    await service.runUntilPause(taskId);

    const machineState = service.state(taskId);
    const state = server.state(taskId);
    expect(machineState.value, JSON.stringify({
      context: machineState.context,
      coverage: service.fieldCoverage(taskId),
      progress: service.progress(taskId),
      remote: state,
      executionResults
    }, null, 2)).toBe("review_locked");

    expect(state.workAddCount).toBe(0);
    expect(state.internshipAddCount).toBe(0);
    expect(state.projectAddCount).toBe(1);
    expect(state.searches.major).toEqual(["软件工程专业", "软件工程"]);
    expect(state.draft).toMatchObject({
      major: "软件工程",
      formalWorkCompanies: [""],
      internshipCompanies: ["星云科技"],
      internshipPositions: ["Java 后端实习"],
      projectNames: ["ApplyPilot", "CodeGraph Lab"],
      projectDescriptions: ["受控浏览器简历投递助手", "代码关系分析工具"],
      awardName: "全国大学生软件测试大赛",
      awardDate: "2023-11",
      startYear: "2022",
      startMonth: "10",
      languageName: "英语",
      languageProficiency: "熟练",
      languageSpeakingListening: "熟练",
      languageReadingWriting: "熟练",
      preservedValue: "用户预填内容"
    });
    expect(state.submissionCount).toBe(0);

    const finalSnapshot = await executor.observe(taskId);
    expect(finalSnapshot.actions.some((action) => action.class === "terminal_submit")).toBe(true);
    expect(service.progress(taskId).executionProgress).toMatchObject({
      currentPhase: "final_review",
      phases: expect.arrayContaining([
        expect.objectContaining({ phase: "final_review", status: "running" })
      ])
    });
    expect(service.fieldCoverage(taskId)).toMatchObject({ failed: 0 });
  } finally {
    await server.close();
    database.close();
  }
});
