import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { ActionPolicy } from "../../packages/action-policy/src/index.js";
import type { ChallengeDiagnostic, ChallengeKind, FormField, PageAction } from "../../packages/contracts/src/browser.js";
import { startSyntheticAts } from "../../apps/synthetic-ats/src/server.js";
import { createApplicationService } from "../../apps/api/src/applications/application-service.js";
import { createCheckpointRepository } from "../../apps/api/src/applications/checkpoint-repository.js";
import { BrowserWorkerClient } from "../../apps/api/src/browser/worker-client.js";
import { createSqliteDatabase } from "../../apps/api/src/db/client.js";
import { migrateDatabase } from "../../apps/api/src/db/migrate.js";
import { ControlledExecutor } from "../../apps/browser-worker/src/executor.js";
import { BrowserObserver } from "../../apps/browser-worker/src/observer.js";
import { ChallengeDetector } from "../../apps/browser-worker/src/challenge-detector.js";
import { createServer, type ViteDevServer } from "../../apps/web/node_modules/vite/dist/node/index.js";
import { fileURLToPath } from "node:url";
import { createApp, type AppDependencies } from "../../apps/api/src/app.js";
import { createProfileRepository } from "../../apps/api/src/profile/profile-repository.js";
import { createLocalOriginalDocumentStore } from "../../apps/api/src/profile/original-document-store.js";
import { createLocalAvatarStore } from "../../apps/api/src/profile/avatar-store.js";
import { createAdapterHealthRegistry } from "../../apps/api/src/health/adapter-health.js";
import type { ExtractedDocument } from "../../packages/profile-domain/src/pdf/types.js";
import type { ProfileFact } from "../../packages/contracts/src/profile.js";

export type ChallengeP0Scenario =
  | "captcha"
  | "access-denied"
  | "rate-limited"
  | "device-verification"
  | "risk-control"
  | "interactive-iframe"
  | "open-shadow-input"
  | "closed-shadow-host";

export interface ChallengeP0State {
  submissionCount: number;
  challenge: {
    scenario: ChallengeP0Scenario;
    kind: ChallengeKind;
    fillCount: number;
  };
}

export interface FullStackWebHarnessOptions {
  extractPdf?(bytes: Uint8Array): Promise<ExtractedDocument>;
  extractFacts?(document: ExtractedDocument): Promise<ProfileFact[]>;
  configure?(dependencies: AppDependencies): void;
}

export async function createFullStackWebHarness(options: FullStackWebHarnessOptions = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "resume-full-stack-"));
  const database = createSqliteDatabase(join(temporaryRoot, "resume-assistant.sqlite"));
  migrateDatabase(database);
  const profileRepository = createProfileRepository(database);
  const dependencies: AppDependencies = {
    database,
    profileRepository,
    originalDocumentStore: createLocalOriginalDocumentStore(join(temporaryRoot, "originals")),
    avatarStore: createLocalAvatarStore(join(temporaryRoot, "originals")),
    adapterHealth: createAdapterHealthRegistry(),
    extractPdf: options.extractPdf ?? (async (bytes) => ({
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
      pages: [{ page: 1, text: "Ada Lovelace", source: "pdf_text" }]
    })),
    extractFacts: options.extractFacts ?? (async (document) => [{
      id: `fact-${document.fingerprint.slice(0, 12)}`,
      fieldPath: "basics.name",
      value: "Ada Lovelace",
      status: "extracted",
      confidence: 1,
      scope: "profile",
      evidence: [{ documentId: document.fingerprint, page: 1, text: "Ada Lovelace", extraction: "pdf_text" }],
      revision: 1
    }])
  };
  options.configure?.(dependencies);
  const api = await createApp(dependencies);
  let web: ViteDevServer | undefined;
  try {
    await api.listen({ host: "127.0.0.1", port: 0 });
    const apiAddress = api.server.address();
    if (!apiAddress || typeof apiAddress === "string") throw new Error("full_stack_api_not_listening");
    const apiOrigin = `http://127.0.0.1:${apiAddress.port}`;
    web = await createServer({
      root: fileURLToPath(new URL("../../apps/web", import.meta.url)),
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: { "/api": { target: apiOrigin } }
      },
      logLevel: "silent"
    });
    await web.listen();
    const webAddress = web.httpServer?.address();
    if (!webAddress || typeof webAddress === "string") throw new Error("full_stack_web_not_listening");
    return {
      database,
      profileRepository,
      apiOrigin,
      webBaseUrl: `http://127.0.0.1:${webAddress.port}`,
      temporaryRoot,
      async close(): Promise<void> {
        await web?.close();
        await api.close();
        if (database.open) database.close();
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await web?.close().catch(() => undefined);
    await api.close().catch(() => undefined);
    if (database.open) database.close();
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function createChallengeP0Harness(page: Page, scenario: ChallengeP0Scenario) {
  const taskId = randomUUID();
  const server = await startSyntheticAts();
  const database = createSqliteDatabase(":memory:");
  migrateDatabase(database);
  const approvalKey = Buffer.alloc(32, 53);
  const policy = new ActionPolicy(approvalKey);
  const detector = new ChallengeDetector();
  detector.start(page);
  const executor = new ControlledExecutor(new BrowserObserver(page, detector), approvalKey);
  const calls: Array<"observe" | "execute" | "invalidate"> = [];
  const applicationUrl = `http://jobs.mokahr.com/application?taskId=${encodeURIComponent(taskId)}&scenario=${encodeURIComponent(scenario)}`;
  const routePattern = "http://jobs.mokahr.com/**";

  await page.route(routePattern, async (route) => {
    const requested = new URL(route.request().url());
    const response = await fetch(`${server.baseUrl}/challenge-p0${requested.search}`);
    await route.fulfill({
      status: response.status,
      contentType: response.headers.get("content-type") ?? "text/html; charset=utf-8",
      body: await response.text()
    });
  });
  await page.goto(applicationUrl);

  const service = createApplicationService({
    checkpoints: createCheckpointRepository(database),
    browser: {
      async observe(id) {
        calls.push("observe");
        return executor.observe(id);
      },
      async execute(command) {
        calls.push("execute");
        return executor.execute(command);
      },
      async invalidateExecution(id) {
        calls.push("invalidate");
        await executor.invalidate(id);
      }
    },
    resolveField: async () => ({ status: "blocked" as const }),
    approve: (request, snapshot) => policy.approve(request, snapshot, {
      valid: snapshot.errors.length === 0
    }).token
  });
  service.start({ taskId, applicationUrl });
  await service.runUntilPause(taskId);

  const readState = async (): Promise<ChallengeP0State> => {
    const response = await fetch(`${server.baseUrl}/api/state?taskId=${encodeURIComponent(taskId)}`);
    return response.json() as Promise<ChallengeP0State>;
  };

  return {
    applicationState: () => service.state(taskId).value,
    challenge: (): ChallengeDiagnostic | undefined => service.state(taskId).context.challenge,
    browserCalls: () => [...calls],
    state: readState,
    clearChallenge: () => page.evaluate(() => {
      const fixture = (window as unknown as { challengeP0?: { clear(): void } }).challengeP0;
      if (!fixture) throw new Error("challenge_p0_missing");
      fixture.clear();
    }),
    resumeAfterChallenge: () => service.resumeAfterChallenge(taskId),
    async close(): Promise<void> {
      detector.dispose();
      await executor.release();
      await page.unroute(routePattern);
      await server.close();
      database.close();
    }
  };
}

export type RuntimeP0Scenario =
  | "stable"
  | "insert-before"
  | "replace-same-index"
  | "reorder"
  | "rollback-500ms"
  | "continuous-mutation";

export interface RuntimeP0State {
  submissionCount: number;
  runtime: {
    scenario: string;
    values: Record<string, string>;
    writeCounts: Record<string, number>;
    mutationCount: number;
    auditCount: number;
  };
}

export async function createRuntimeP0Harness(page: Page, scenario: RuntimeP0Scenario) {
  const taskId = randomUUID();
  const server = await startSyntheticAts();
  const approvalKey = Buffer.alloc(32, 41);
  const policy = new ActionPolicy(approvalKey);
  const executor = new ControlledExecutor(new BrowserObserver(page), approvalKey);
  const applicationUrl = `${server.baseUrl}/runtime-p0?taskId=${encodeURIComponent(taskId)}&scenario=${encodeURIComponent(scenario)}`;
  await page.goto(applicationUrl);
  let snapshot = await executor.observe(taskId);
  let executionEpoch = 0;
  let lastResult: Awaited<ReturnType<ControlledExecutor["execute"]>> | undefined;
  const ownedDatabases: Array<ReturnType<typeof createSqliteDatabase>> = [];

  const runtimeField = (key: string): FormField => {
    const field = snapshot.fields.find((candidate) => candidate.semanticHint === `basics.${key}`);
    if (field === undefined) throw new Error(`runtime_field_missing:${key}`);
    return field;
  };

  const readState = async (): Promise<RuntimeP0State> => {
    const response = await fetch(`${server.baseUrl}/api/state?taskId=${encodeURIComponent(taskId)}`);
    return response.json() as Promise<RuntimeP0State>;
  };

  return {
    async triggerMutation(): Promise<void> {
      await page.evaluate(async () => {
        const runtime = (window as unknown as {
          runtimeP0?: { triggerMutation(): Promise<void> };
        }).runtimeP0;
        if (runtime === undefined) throw new Error("runtime_p0_missing");
        await runtime.triggerMutation();
      });
    },

    async apply(key: string, value: string) {
      const field = runtimeField(key);
      executionEpoch += 1;
      const approval = policy.approve({
        taskId,
        snapshotId: snapshot.id,
        targetId: field.id,
        operation: "fill",
        nodeRef: field.nodeRef,
        executionEpoch
      }, snapshot, { valid: snapshot.errors.length === 0 }).token;
      lastResult = await executor.execute({
        type: "fill",
        taskId,
        snapshotId: snapshot.id,
        fieldId: field.id,
        nodeRef: field.nodeRef,
        executionEpoch,
        value,
        approval
      });
      snapshot = lastResult.snapshot;
      return lastResult;
    },

    async runEightStableWritesToAudit(): Promise<ReturnType<ReturnType<typeof createApplicationService>["progress"]>> {
      const database = createSqliteDatabase(":memory:");
      ownedDatabases.push(database);
      migrateDatabase(database);
      const service = createApplicationService({
        checkpoints: createCheckpointRepository(database),
        browser: {
          observe: async (id) => {
            await page.evaluate(async () => {
              const runtime = (window as unknown as {
                runtimeP0?: { prepareAudit(): Promise<void> };
              }).runtimeP0;
              if (runtime === undefined) throw new Error("runtime_p0_missing");
              await runtime.prepareAudit();
            });
            return executor.observe(id);
          },
          execute: async (command) => {
            const result = await executor.execute(command);
            lastResult = result;
            snapshot = result.snapshot;
            return result;
          }
        },
        resolveField: async (_id, field) => {
          if (!field.semanticHint?.startsWith("basics.audit")) {
            return {
              status: "needs_question" as const,
              ...(field.semanticHint === undefined ? {} : { fieldPath: field.semanticHint }),
              question: `runtime fixture leaves ${field.label} untouched`
            };
          }
          return {
            status: "verified" as const,
            value: `value-${field.semanticHint.slice("basics.audit".length)}`,
            fieldPath: field.semanticHint,
            assessment: {
              fieldId: field.id,
              label: field.label,
              semantic: field.semanticHint,
              status: "ready" as const,
              source: "exact" as const,
              confidence: 1,
              reason: "runtime-p0-fixture",
              evidence: []
            }
          };
        },
        approve: (request, currentSnapshot) => policy.approve(request, currentSnapshot, {
          valid: currentSnapshot.errors.length === 0
        }).token
      });
      service.start({ taskId, applicationUrl });
      await service.runUntilPause(taskId, snapshot);
      return service.progress(taskId);
    },

    value: (key: string) => page.locator(`[data-runtime-key="${key}"]`).inputValue(),
    lastError: () => lastResult?.errors[0],
    state: readState,

    async close(): Promise<void> {
      await executor.release();
      await server.close();
      ownedDatabases.forEach((database) => database.close());
    }
  };
}

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
      const action = reviewSnapshot.actions.find((candidate) => candidate.id === actionId);
      if (!action) throw new Error("审核动作不存在");
      return policy.approve({
        taskId,
        snapshotId: reviewSnapshot.id,
        targetId: actionId,
        operation: "click_intermediate",
        nodeRef: action.nodeRef,
        executionEpoch: 1
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
