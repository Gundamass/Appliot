import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  ApplicationFieldSemanticSchema,
  ApplicationSkillVersionSchema,
  type CanonicalIntent,
  type PlanState,
  type PlanStep
} from "../../packages/contracts/src/index.js";
import { ActionPolicy } from "../../packages/action-policy/src/index.js";
import { createApplicationTools } from "../../apps/api/src/agent/application-tools.js";
import { createInMemoryEvidenceStore } from "../../apps/api/src/agent/observations/evidence-store.js";
import { createRuntimeApplicationStateStore } from "../../apps/api/src/agent/runtime/application-state-store.js";
import type { RuntimeExecutorInput, RuntimeExecutorResult } from "../../apps/api/src/agent/runtime/execution-loop.js";
import { createApplicationAgent } from "../../apps/api/src/agent/specialists/application-agent.js";
import { bootstrapApplicationSkills } from "../../apps/api/src/application-skills/bootstrap.js";
import { SkillExecutionRecorder } from "../../apps/api/src/application-skills/skill-execution-recorder.js";
import { SkillRegistry } from "../../apps/api/src/application-skills/skill-registry.js";
import { createApplicationSkillRuntime } from "../../apps/api/src/application-skills/skill-selector.js";
import { createSqliteDatabase } from "../../apps/api/src/db/client.js";
import { migrateDatabase } from "../../apps/api/src/db/migrate.js";
import { ControlledExecutor } from "../../apps/browser-worker/src/executor.js";
import { BrowserObserver } from "../../apps/browser-worker/src/observer.js";
import {
  startSyntheticAts,
  type SyntheticSkillRuntimeScenario,
  type SyntheticSkillRuntimeSite,
  type SyntheticTaskState
} from "../../apps/synthetic-ats/src/server.js";

const VALUES: Readonly<Record<string, string>> = {
  "basics.name": "Skill Runtime Candidate",
  "basics.email": "skill-runtime@example.test",
  "basics.phone": "13800138000",
  "education[].institution": "Skill Runtime University",
  "education[0].institution": "Skill Runtime University"
};

const SITE_FIELDS: Record<SyntheticSkillRuntimeSite, string[]> = {
  moka: ["basics.name", "basics.email", "basics.phone"],
  dji: ["basics.name", "basics.phone", "education[0].institution"],
  baidu: []
};

const EXPECTED_BINDINGS: Record<SyntheticSkillRuntimeSite, { fingerprint: string; allocationId: string }> = {
  moka: {
    fingerprint: "b70b76ca0d8242abc1422088ae102f05e7157c6bc45e93724bfdbe1eebbe543d",
    allocationId: "allocation-moka-b70b76ca0d8242abc1422088"
  },
  dji: {
    fingerprint: "6f00113954dd164379bdb9bcc230c461e0d16da2b4995901fdf9a6b27404b4d5",
    allocationId: "allocation-dji-6f00113954dd164379bdb9bc"
  },
  baidu: {
    fingerprint: "004c4bb7116a509a332df5f17b4553b04129d05383a02a693447622a4f5f6fc3",
    allocationId: "allocation-baidu-004c4bb7116a509a332df5f1"
  }
};

for (const site of ["moka", "dji", "baidu"] as const) {
  test(`${site} selects one stable Champion, survives reload, and stays pre-submit`, async ({ page }, testInfo) => {
    const harness = await createSkillRuntimeHarness(page, site, "stable");
    try {
      const first = await harness.runStep("fill-1");
      const firstBinding = await harness.binding();
      expect(firstBinding).toMatchObject({
        skillId: `${site}-application`,
        version: "1.0.0",
        site,
        pageFingerprintHash: EXPECTED_BINDINGS[site].fingerprint,
        allocationId: EXPECTED_BINDINGS[site].allocationId
      });

      await page.reload();
      await harness.runToReview("after-reload");

      expect(await harness.binding()).toEqual(firstBinding);
      expect(first.status).toBe(site === "baidu" ? "interrupted" : "completed");
      expect((await harness.state()).skillRuntime.values).toEqual(expectedValues(site));
      expect(Object.values((await harness.state()).skillRuntime.writeCounts)).toEqual(
        SITE_FIELDS[site].map(() => 1)
      );
      expect((await harness.state()).submissionCount).toBe(0);
      expect(harness.records()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          recordId: expect.stringMatching(/^skill-record-[a-f0-9]{32}$/u),
          binding: expect.objectContaining({ skillId: `${site}-application`, version: "1.0.0" }),
          pageVariantId: "application-form",
          allocation: "champion"
        })
      ]));
      expect(JSON.stringify(harness.records())).not.toContain("Skill Runtime Candidate");
      expect(JSON.stringify(harness.records())).not.toContain("13800138000");
      await testInfo.attach(`matched-${site}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png"
      });
    } finally {
      await harness.close();
    }
  });
}

test("renamed labels still resolve through declared semantics", async ({ page }) => {
  const harness = await createSkillRuntimeHarness(page, "moka", "renamed-label");
  try {
    await harness.runToReview("renamed");
    expect((await harness.state()).skillRuntime.values).toEqual(expectedValues("moka"));
    expect((await harness.state()).submissionCount).toBe(0);
  } finally {
    await harness.close();
  }
});

test("delayed rendering is observed before the DJI Champion fills", async ({ page }) => {
  const harness = await createSkillRuntimeHarness(page, "dji", "delayed-render");
  try {
    await harness.runToReview("delayed");
    expect((await harness.state()).skillRuntime.values).toEqual(expectedValues("dji"));
    expect((await harness.state()).submissionCount).toBe(0);
  } finally {
    await harness.close();
  }
});

test("duplicate declared semantics force takeover before any write", async ({ page }) => {
  const harness = await createSkillRuntimeHarness(page, "moka", "duplicate-label");
  try {
    const result = await harness.runStep("duplicate");
    expect(result).toMatchObject({ status: "interrupted" });
    expect((await harness.state()).skillRuntime).toMatchObject({ values: {}, writeCounts: {} });
    expect((await harness.state()).submissionCount).toBe(0);
  } finally {
    await harness.close();
  }
});

test("a stale node fails closed and records the Champion failure", async ({ page }) => {
  const harness = await createSkillRuntimeHarness(page, "moka", "stale-node", { staleAfterFirstObservation: true });
  try {
    const result = await harness.runStep("stale");
    expect(result).toMatchObject({ status: "failed" });
    expect((await harness.state()).skillRuntime).toMatchObject({ values: {}, writeCounts: {} });
    expect((await harness.state()).submissionCount).toBe(0);
    expect(harness.records(), JSON.stringify(harness.executionErrors())).toEqual(expect.arrayContaining([
      expect.objectContaining({ terminalResult: "failed", firstError: expect.any(Object) })
    ]));
  } finally {
    await harness.close();
  }
});

test("an ambiguous page fingerprint hands off without selecting or writing", async ({ page }) => {
  const harness = await createSkillRuntimeHarness(page, "moka", "ambiguous-fingerprint", { ambiguousChampion: true });
  try {
    const result = await harness.runStep("ambiguous");
    expect(result).toMatchObject({ status: "interrupted" });
    expect(await harness.binding()).toBeUndefined();
    expect((await harness.state()).skillRuntime).toMatchObject({ values: {}, writeCounts: {} });
    expect((await harness.state()).submissionCount).toBe(0);
  } finally {
    await harness.close();
  }
});

test("unexpected navigation stops after the first write and never submits", async ({ page }) => {
  const harness = await createSkillRuntimeHarness(page, "moka", "unexpected-navigation");
  try {
    const result = await harness.runStep("unexpected-navigation");
    expect(result.status).toBe("failed");
    const state = await harness.state();
    expect(state.skillRuntime.values).toEqual({ "basics.name": VALUES["basics.name"] });
    expect(state.skillRuntime.writeCounts).toEqual({ "basics.name": 1 });
    expect(state.skillRuntime.navigationCount).toBe(1);
    expect(state.submissionCount).toBe(0);
    expect(harness.records(), JSON.stringify(harness.executionErrors())).toEqual(expect.arrayContaining([
      expect.objectContaining({
        terminalResult: "failed",
        auditMismatchClasses: expect.arrayContaining(["unexpected_navigation"]),
        firstError: expect.objectContaining({ stage: "write", errorClass: "write_failed" })
      })
    ]));
  } finally {
    await harness.close();
  }
});

test("a supported origin on an unmatched route stays observe-only", async ({ page }, testInfo) => {
  const harness = await createSkillRuntimeHarness(page, "moka", "stable", { unmatchedRoute: true });
  try {
    const result = await harness.runStep("unmatched");
    expect(result).toMatchObject({ status: "interrupted" });
    expect(await harness.binding()).toBeUndefined();
    expect((await harness.state()).skillRuntime).toMatchObject({ values: {}, writeCounts: {} });
    expect((await harness.state()).submissionCount).toBe(0);
    await testInfo.attach("unmatched-observe-only", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png"
    });
  } finally {
    await harness.close();
  }
});

test("the final-submit step is acknowledgement-only even on a live terminal control", async ({ page }) => {
  const harness = await createSkillRuntimeHarness(page, "moka", "stable");
  try {
    await harness.runToReview("pre-submit");
    const before = await harness.state();
    const result = await harness.runStep("final-submit", "final_submit", "irreversible");
    const after = await harness.state();

    expect(result).toMatchObject({ status: "completed", toolCallsUsed: 0 });
    expect(after.submissionCount).toBe(0);
    expect(after.skillRuntime.writeCounts).toEqual(before.skillRuntime.writeCounts);
  } finally {
    await harness.close();
  }
});

interface HarnessOptions {
  staleAfterFirstObservation?: boolean;
  ambiguousChampion?: boolean;
  unmatchedRoute?: boolean;
}

async function createSkillRuntimeHarness(
  page: Page,
  site: SyntheticSkillRuntimeSite,
  scenario: SyntheticSkillRuntimeScenario,
  options: HarnessOptions = {}
) {
  const taskId = `task-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  const server = await startSyntheticAts();
  const database = createSqliteDatabase(":memory:");
  migrateDatabase(database);
  const registry = new SkillRegistry(database);
  bootstrapApplicationSkills(registry);
  const runtimeRegistry = options.ambiguousChampion
    ? ambiguousRegistry(registry, site)
    : registry;
  const stateStore = createRuntimeApplicationStateStore(database);
  const skillRuntime = createApplicationSkillRuntime({
    registry: runtimeRegistry,
    bindingStoreFor(requestedRunId) {
      return {
        async get(requestedTaskId) {
          const state = await stateStore.get(requestedRunId);
          return state?.taskId === requestedTaskId ? state.skillBinding : undefined;
        },
        putIfAbsent(requestedTaskId, binding) {
          return stateStore.bindSkill(requestedRunId, requestedTaskId, binding);
        }
      };
    }
  });
  const records = () => database.prepare(
    "SELECT payload_json FROM skill_execution_records ORDER BY created_at, record_id"
  ).all().map((row) => JSON.parse((row as { payload_json: string }).payload_json) as Record<string, unknown>);
  const recorder = new SkillExecutionRecorder({
    async append(record) {
      registry.appendExecutionRecord(record);
    }
  });
  const applicationUrl = urlFor(site, taskId, scenario, options.unmatchedRoute === true);
  const origin = new URL(applicationUrl).origin;
  await page.route(`${origin}/**`, (route) => proxySkillRoute(route, server.baseUrl, site, scenario, taskId));
  await page.goto(applicationUrl);

  const approvalKey = Buffer.alloc(32, 73);
  const policy = new ActionPolicy(approvalKey);
  const executor = new ControlledExecutor(new BrowserObserver(page), approvalKey);
  let executionErrors: string[] = [];
  let observed = false;
  const tools = createApplicationTools({
    browser: {
      async observe(id) {
        const snapshot = await executor.observe(id);
        if (!observed && options.staleAfterFirstObservation) {
          observed = true;
          await page.evaluate(() => {
            const fixture = (window as unknown as { skillRuntimeFixture?: { triggerStaleNode(): void } }).skillRuntimeFixture;
            if (fixture === undefined) throw new Error("skill_runtime_fixture_missing");
            fixture.triggerStaleNode();
          });
        }
        return snapshot;
      },
      async execute(command) {
        const result = await executor.execute(command);
        executionErrors = [...result.errors];
        return result;
      },
      invalidateExecution: (id) => executor.invalidate(id)
    },
    async resolveField(_id, field) {
      const semantic = ApplicationFieldSemanticSchema.safeParse(semanticTemplate(field.semanticHint));
      if (!semantic.success || VALUES[semantic.data] === undefined) {
        return { status: "blocked" as const };
      }
      return { status: "verified" as const, value: VALUES[semantic.data], fieldPath: semantic.data };
    },
    approve(input, snapshot) {
      return policy.approve(input, snapshot, { valid: snapshot.errors.length === 0 }).token;
    }
  });
  const agent = createApplicationAgent({
    tools,
    evidenceStore: createInMemoryEvidenceStore(),
    stateStore,
    skillRuntime,
    skillExecutionRecorder: recorder,
    profileRevision: () => 1
  });
  let stepIndex = 0;
  const runStep = async (
    id: string,
    objective = "fill_application",
    risk: PlanStep["risk"] = "low"
  ): Promise<RuntimeExecutorResult> => {
    stepIndex += 1;
    return agent.execute(runtimeInput(runId, taskId, applicationUrl, id, objective, risk, stepIndex));
  };

  return {
    runStep,
    async runToReview(prefix: string): Promise<void> {
      let result: RuntimeExecutorResult | undefined;
      for (let index = 0; index < 6; index += 1) {
        result = await runStep(`${prefix}-${index}`);
        if (result.status === "interrupted") break;
        if (result.status === "failed") throw new Error(`skill_runtime_failed:${result.errorCode}`);
      }
      expect(result?.status).toBe("interrupted");
      if (result?.pendingInterrupt?.reason !== "final_submit") {
        throw new Error(JSON.stringify({
          result,
          persisted: await stateStore.get(runId),
          remote: server.state(taskId),
          snapshot: await executor.observe(taskId)
        }, null, 2));
      }
    },
    binding: async () => (await stateStore.get(runId))?.skillBinding,
    state: async (): Promise<SyntheticTaskState> => {
      await page.evaluate(async () => {
        const fixture = (window as unknown as { skillRuntimeFixture?: { flush?(): Promise<unknown> } }).skillRuntimeFixture;
        await fixture?.flush?.();
      }).catch(() => undefined);
      return server.state(taskId);
    },
    records,
    executionErrors: () => [...executionErrors],
    async close(): Promise<void> {
      await executor.release();
      await page.unroute(`${origin}/**`);
      await server.close();
      database.close();
    }
  };
}

function expectedValues(site: SyntheticSkillRuntimeSite): Record<string, string> {
  return Object.fromEntries(SITE_FIELDS[site].map((semantic) => [semantic, VALUES[semantic]!]));
}

function semanticTemplate(value: unknown): unknown {
  return typeof value === "string"
    ? value.replace(/^([a-z]+)\[\d+\]/u, "$1[]")
    : value;
}

function urlFor(
  site: SyntheticSkillRuntimeSite,
  taskId: string,
  scenario: SyntheticSkillRuntimeScenario,
  unmatched: boolean
): string {
  const query = `taskId=${encodeURIComponent(taskId)}&scenario=${encodeURIComponent(scenario)}`;
  if (site === "moka") {
    return `https://app.mokahr.com/${unmatched ? "careers/home" : "social-recruitment/acme/job-1/apply"}?${query}`;
  }
  if (site === "dji") return `https://apply.careers.dji.com/campus-recruitment/dji/job-1/apply?${query}`;
  return `https://talent.baidu.com/jobs/detail/GRADUATE/job-1/apply?${query}`;
}

async function proxySkillRoute(
  route: Route,
  baseUrl: string,
  site: SyntheticSkillRuntimeSite,
  scenario: SyntheticSkillRuntimeScenario,
  taskId: string
): Promise<void> {
  const requested = new URL(route.request().url());
  const path = requested.pathname === "/api/skill-runtime-state"
    || requested.pathname === "/skill-runtime-unexpected"
    || requested.pathname === "/submit"
    ? `${requested.pathname}${requested.search}`
    : `/skill-runtime?taskId=${encodeURIComponent(taskId)}&site=${site}&scenario=${scenario}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method: route.request().method(),
    headers: route.request().headers(),
    ...(route.request().postDataBuffer() === null ? {} : { body: route.request().postDataBuffer() })
  });
  await route.fulfill({
    status: response.status,
    contentType: response.headers.get("content-type") ?? "text/html; charset=utf-8",
    body: Buffer.from(await response.arrayBuffer())
  });
}

function ambiguousRegistry(
  registry: SkillRegistry,
  site: SyntheticSkillRuntimeSite
): SkillRegistry {
  return new Proxy(registry, {
    get(target, property, receiver) {
      if (property !== "getChampionForSite") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (requestedSite: SyntheticSkillRuntimeSite) => {
        const champion = ApplicationSkillVersionSchema.parse(target.getChampionForSite(requestedSite));
        if (requestedSite !== site) return champion;
        const original = champion.content.pageVariants[0]!;
        return {
          ...champion,
          content: {
            ...champion.content,
            pageVariants: [original, { ...original, id: "ambiguous-copy" }]
          }
        };
      };
    }
  });
}

function runtimeInput(
  runId: string,
  taskId: string,
  applicationUrl: string,
  stepId: string,
  objective: string,
  risk: PlanStep["risk"],
  attempt: number
): RuntimeExecutorInput {
  const intent = {
    intentId: `intent-${runId}`,
    schemaVersion: "1.0.0",
    revision: 1,
    rawInputRef: "message-skill-runtime",
    primaryGoal: "fill_application",
    subGoals: ["fill_application"],
    entities: {},
    constraints: [],
    preferences: [],
    successCriteria: [],
    riskProfile: { level: "high", requiresHumanApproval: true, reasons: ["external application action"] },
    confidence: 1,
    ambiguities: [],
    missingInformation: [],
    autonomyLevel: "execute_with_approval",
    evidenceRefs: [],
    createdAt: "2026-09-07T00:00:00.000Z"
  } as CanonicalIntent;
  const step: PlanStep = {
    id: stepId,
    objective,
    owner: "application",
    status: "running",
    dependsOn: [],
    inputRefs: [intent.intentId],
    outputRefs: [],
    attempt,
    attemptToken: `attempt-${attempt}`,
    maxAttempts: 2,
    acceptanceCriteria: [`${objective} completed`],
    risk
  };
  const plan = {
    planId: `plan-${runId}`,
    intentId: intent.intentId,
    revision: 1,
    steps: [step],
    assumptions: [],
    approvalPoints: [],
    estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1 },
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z"
  } satisfies PlanState;
  return {
    runId,
    step,
    intent,
    plan,
    decision: { type: "dispatch_agent", agent: "application_agent", input: { stepId }, reason: "e2e" },
    signal: new AbortController().signal,
    executionEpoch: attempt,
    request: {
      goal: "fill application safely",
      requestedBy: "browser-e2e",
      contextRefs: [],
      metadata: { applicationTaskId: taskId, applicationUrl, profileRevision: 1 }
    }
  };
}
