import { describe, expect, it, vi } from "vitest";
import type { CanonicalIntent, PlanState, PlanStep, FormSnapshot, ExecutableCommand } from "@resume/contracts";
import type { RuntimeExecutorInput } from "../runtime/execution-loop.js";
import { createInMemoryEvidenceStore } from "../observations/evidence-store.js";
import { createRuntimeApplicationStateStore } from "../runtime/application-state-store.js";
import { createApplicationAgent } from "./application-agent.js";

const intent = {
  intentId: "intent-application-agent",
  schemaVersion: "1.0.0",
  revision: 1,
  rawInputRef: "message-1",
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
  createdAt: "2026-09-03T00:00:00.000Z"
} as CanonicalIntent;

const snapshot: FormSnapshot = {
  taskId: "task-1",
  id: "snapshot-1",
  url: "https://jobs.example.test/apply",
  title: "Application",
  stage: "application_form",
  frameRef: { documentId: "document-1", kind: "main" },
  mutationEpoch: 1,
  fields: [{
    id: "field-1",
    label: "Field",
    type: "text",
    required: false,
    options: [],
    currentValue: "",
    nodeRef: { documentId: "document-1", nodeId: "node-1", observedAt: 1 }
  }],
  actions: [],
  errors: []
};
const command = {
  type: "fill",
  taskId: "task-1",
  snapshotId: "snapshot-1",
  fieldId: "field-1",
  nodeRef: { documentId: "document-1", nodeId: "node-1", observedAt: 1 },
  executionEpoch: 1,
  value: "value",
  approval: "approval"
} as ExecutableCommand;

function step(objective: string, risk: PlanStep["risk"] = "low"): PlanStep {
  return {
    id: objective,
    objective,
    owner: "application",
    status: "running",
    dependsOn: [],
    inputRefs: [intent.intentId],
    outputRefs: [],
    attempt: 0,
    attemptToken: "attempt-1",
    maxAttempts: 2,
    acceptanceCriteria: [`${objective} completed`],
    risk
  };
}

function input(currentStep: PlanStep): RuntimeExecutorInput {
  return {
    runId: "run-1",
    step: currentStep,
    intent,
    plan: {
      planId: "plan-1",
      intentId: intent.intentId,
      revision: 1,
      steps: [currentStep],
      assumptions: [],
      approvalPoints: [],
      estimatedCost: { steps: 1, toolCalls: 0, tokens: 0, durationMs: 1 },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z"
    } satisfies PlanState,
    decision: {
      type: "dispatch_agent",
      agent: "application_agent",
      input: { stepId: currentStep.id },
      reason: "test"
    },
    signal: new AbortController().signal,
    executionEpoch: 0,
    request: {
      goal: "fill application",
      requestedBy: "user-1",
      contextRefs: [],
      metadata: {
        applicationTaskId: "task-1",
        applicationUrl: snapshot.url
      }
    }
  };
}

describe("ApplicationAgent", () => {
  it("executes a planned fill through observe, resolve, authorize, execute and readback", async () => {
    const execute = vi.fn(async () => ({
      type: "execution_result" as const,
      taskId: "task-1",
      snapshotId: "snapshot-2",
      commandType: "fill" as const,
      status: "applied" as const,
      actualValue: "value",
      snapshot
    }));
    const tools = {
      observe: vi.fn(async () => snapshot),
      normalize: vi.fn((value: FormSnapshot) => value),
      resolveFields: vi.fn(async () => ({
        token: "resolution-1",
        snapshotId: snapshot.id,
        phase: "deterministic" as const,
        resolutions: []
      })),
      buildPlan: vi.fn(async () => [command]),
      buildNavigationPlan: vi.fn(async () => undefined),
      authorize: vi.fn(async (value: ExecutableCommand) => value),
      execute,
      readback: vi.fn(async () => ({ status: "confirmed" as const, observations: 2, snapshot })),
      fullPageAudit: vi.fn(async ({ snapshot: current }: { snapshot: FormSnapshot }) => ({ snapshot: current, mismatches: [] })),
      invalidate: vi.fn(async () => 1),
      release: vi.fn(async () => undefined)
    };
    const evidenceStore = createInMemoryEvidenceStore();
    const agent = createApplicationAgent({ tools: tools as never, evidenceStore, profileRevision: () => 1 });

    const result = await agent.execute(input(step("fill_application")));

    expect(result.status).toBe("completed");
    expect(result.evidenceRefs?.length).toBeGreaterThan(0);
    expect(tools.observe).toHaveBeenCalledWith("task-1");
    expect(execute).toHaveBeenCalledWith(command);
    expect(result.evidenceRefs?.every((ref) => evidenceStore.has(ref.id))).toBe(true);
  });

  it("records one redacted Skill execution attempt after the Champion flow completes", async () => {
    const skillSnapshot: FormSnapshot = {
      ...snapshot,
      url: "https://talent.baidu.com/jobs/detail/application/123",
      fields: [{ ...snapshot.fields[0]!, semanticHint: "basics.email" }]
    };
    const binding = {
      skillId: "baidu-application",
      version: "1.0.0",
      site: "baidu" as const,
      pageFingerprintHash: "d".repeat(64),
      allocationId: "allocation-baidu-campus"
    };
    const tools = {
      observe: vi.fn(async () => skillSnapshot),
      normalize: vi.fn((value: FormSnapshot) => value),
      resolveFields: vi.fn(async () => ({
        token: "resolution-skill",
        snapshotId: skillSnapshot.id,
        phase: "deterministic" as const,
        resolutions: []
      })),
      buildPlan: vi.fn(async () => [command]),
      buildNavigationPlan: vi.fn(async () => undefined),
      authorize: vi.fn(async (value: ExecutableCommand) => value),
      execute: vi.fn(async () => ({
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: "snapshot-2",
        commandType: "fill" as const,
        status: "applied" as const,
        actualValue: "candidate@example.com",
        snapshot: skillSnapshot
      })),
      readback: vi.fn(async () => ({ status: "confirmed" as const, observations: 2, snapshot: skillSnapshot })),
      fullPageAudit: vi.fn(async () => ({ snapshot: skillSnapshot, mismatches: [] })),
      invalidate: vi.fn(async () => 1),
      release: vi.fn(async () => undefined)
    };
    const record = vi.fn(async () => undefined);
    const agent = createApplicationAgent({
      tools: tools as never,
      evidenceStore: createInMemoryEvidenceStore(),
      now: () => "2026-09-07T08:00:00.000Z",
      skillRuntime: {
        resolve: vi.fn(async () => ({
          kind: "selected" as const,
          binding,
          pageVariantId: "application-form",
          allocation: "champion" as const,
          directives: [{ kind: "resolve-field" as const, semantic: "basics.email" as const, locatorKeys: ["email"] }]
        }))
      },
      skillExecutionRecorder: { record }
    });

    await expect(agent.execute(input(step("fill_application")))).resolves.toMatchObject({ status: "completed" });

    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      attemptId: expect.stringMatching(/^attempt-[a-f0-9]{32}$/u),
      binding,
      pageVariantId: "application-form",
      allocation: "champion",
      observedSemantics: ["basics.email"],
      fieldPlans: [{ semantic: "basics.email", outcome: "filled" }],
      readbacks: [{ semantic: "basics.email", outcome: "verified" }],
      auditMismatchClasses: [],
      terminalResult: "completed_pre_submit"
    }));
    expect(JSON.stringify(record.mock.calls)).not.toContain("candidate@example.com");
    expect(JSON.stringify(record.mock.calls)).not.toContain("approval");
  });

  it("records a pre-bound attempt that reaches login before Skill selection", async () => {
    const stateStore = createRuntimeApplicationStateStore();
    const binding = {
      skillId: "baidu-application",
      version: "1.0.0",
      site: "baidu" as const,
      pageFingerprintHash: "f".repeat(64),
      allocationId: "allocation-baidu-campus"
    };
    const skillTrace = {
      skillId: binding.skillId,
      skillVersion: binding.version,
      pageFingerprintHash: binding.pageFingerprintHash,
      pageVariantId: "application-form",
      allocation: "champion" as const
    };
    await stateStore.save({
      version: "1.1.0",
      runId: "run-1",
      taskId: "task-1",
      applicationUrl: snapshot.url,
      executionEpoch: 1,
      plannedCommandIds: [],
      completedCommandIds: [],
      retryCount: 0,
      finalReviewLocked: false,
      skillBinding: binding,
      skillTrace,
      updatedAt: "2026-09-07T08:00:00.000Z"
    });
    const loginSnapshot: FormSnapshot = { ...snapshot, title: "Login", stage: "login", fields: [] };
    const tools = {
      observe: vi.fn(async () => loginSnapshot),
      normalize: vi.fn((value: FormSnapshot) => value),
      resolveFields: vi.fn(),
      buildPlan: vi.fn(),
      buildNavigationPlan: vi.fn(),
      authorize: vi.fn(),
      execute: vi.fn(),
      readback: vi.fn(),
      fullPageAudit: vi.fn(),
      invalidate: vi.fn(async () => 2),
      release: vi.fn(async () => undefined)
    };
    const record = vi.fn(async () => undefined);
    const skillResolve = vi.fn();
    const agent = createApplicationAgent({
      tools: tools as never,
      evidenceStore: createInMemoryEvidenceStore(),
      stateStore,
      now: () => "2026-09-07T08:00:01.000Z",
      skillRuntime: { resolve: skillResolve },
      skillExecutionRecorder: { record }
    });

    await expect(agent.execute(input(step("fill_application")))).resolves.toMatchObject({ status: "interrupted" });

    expect(skillResolve).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      binding,
      pageVariantId: "application-form",
      allocation: "champion",
      terminalResult: "handoff"
    }));
  });

  it("persists field coverage metadata without copying evidence text", async () => {
    const stateStore = createRuntimeApplicationStateStore();
    const execute = vi.fn(async () => ({
      type: "execution_result" as const,
      taskId: "task-1",
      snapshotId: "snapshot-2",
      commandType: "fill" as const,
      status: "applied" as const,
      actualValue: "candidate@example.com",
      snapshot
    }));
    const tools = {
      observe: vi.fn(async () => snapshot),
      normalize: vi.fn((value: FormSnapshot) => value),
      resolveFields: vi.fn(async () => ({
        token: "resolution-coverage",
        snapshotId: snapshot.id,
        phase: "deterministic" as const,
        resolutions: [{
          field: snapshot.fields[0]!,
          status: "verified" as const,
          value: "candidate@example.com",
          fieldPath: "basics.email",
          assessment: {
            fieldId: "field-1",
            label: "Email",
            semantic: "basics.email",
            status: "ready" as const,
            source: "exact" as const,
            confidence: 1,
            reason: "evidence_backed",
            evidence: [{ documentId: "resume", page: 1, text: "candidate@example.com", extraction: "pdf_text" as const }]
          }
        }]
      })),
      buildPlan: vi.fn(async () => [command]),
      buildNavigationPlan: vi.fn(async () => undefined),
      authorize: vi.fn(async (value: ExecutableCommand) => value),
      execute,
      readback: vi.fn(async () => ({ status: "confirmed" as const, observations: 2, snapshot })),
      fullPageAudit: vi.fn(async ({ snapshot: value }: { snapshot: FormSnapshot }) => ({ snapshot: value, mismatches: [] })),
      invalidate: vi.fn(async () => 1),
      release: vi.fn(async () => undefined)
    };
    const agent = createApplicationAgent({
      tools: tools as never,
      evidenceStore: createInMemoryEvidenceStore(),
      stateStore,
      profileRevision: () => 1
    });

    await agent.execute(input(step("fill_application")));

    const persisted = await stateStore.get("run-1");
    expect(persisted?.fieldCoverage).toMatchObject({
      total: 1,
      filled: 1,
      fields: [expect.objectContaining({
        fieldId: "field-1",
        status: "filled",
        evidenceRefs: [expect.stringMatching(/^evidence:[a-f0-9]{64}$/u)]
      })]
    });
    expect(JSON.stringify(persisted)).not.toContain("candidate@example.com");
  });

  it("never executes a browser command for the final-submit specialist step", async () => {
    const execute = vi.fn();
    const tools = {
      observe: vi.fn(async () => snapshot),
      normalize: vi.fn((value: FormSnapshot) => value),
      resolveFields: vi.fn(),
      buildPlan: vi.fn(),
      buildNavigationPlan: vi.fn(),
      authorize: vi.fn(async (value: ExecutableCommand) => value),
      execute,
      readback: vi.fn(),
      fullPageAudit: vi.fn(),
      invalidate: vi.fn(),
      release: vi.fn()
    };
    const agent = createApplicationAgent({ tools: tools as never, evidenceStore: createInMemoryEvidenceStore(), profileRevision: () => 1 });

    const result = await agent.execute(input(step("final_submit", "irreversible")));

    expect(result.status).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
    expect(result.errorCode).toBeUndefined();
  });

  it("retains question and safety bindings in a durable human interrupt", async () => {
    const requiredSnapshot: FormSnapshot = {
      ...snapshot,
      fields: [{ ...snapshot.fields[0]!, required: true }]
    };
    const tools = {
      observe: vi.fn(async () => requiredSnapshot),
      normalize: vi.fn((value: FormSnapshot) => value),
      resolveFields: vi.fn(async () => ({
        token: "resolution-question",
        snapshotId: requiredSnapshot.id,
        phase: "deterministic" as const,
        resolutions: [{
          field: requiredSnapshot.fields[0]!,
          status: "needs_question" as const,
          fieldPath: "basics.city",
          assessment: {
            fieldId: "field-1",
            label: "City",
            semantic: "basics.city",
            status: "missing" as const,
            source: "none" as const,
            confidence: 0,
            reason: "missing",
            evidence: []
          }
        }]
      })),
      buildPlan: vi.fn(),
      buildNavigationPlan: vi.fn(),
      authorize: vi.fn(),
      execute: vi.fn(),
      readback: vi.fn(),
      fullPageAudit: vi.fn(),
      invalidate: vi.fn(async () => 1),
      release: vi.fn(async () => undefined)
    };
    const agent = createApplicationAgent({
      tools: tools as never,
      evidenceStore: createInMemoryEvidenceStore(),
      profileRevision: () => 1
    });

    const result = await agent.execute(input(step("fill_application")));

    expect(result.status).toBe("interrupted");
    expect(result.pendingInterrupt?.proposedAction).toEqual(expect.objectContaining({
      kind: "application_review",
      runId: "run-1",
      taskId: "task-1",
      questionIds: ["field:field-1"],
      snapshotId: requiredSnapshot.id,
      executionEpoch: 0
    }));
  });

  it("restores persisted interrupt bindings instead of rebinding to a new plan", async () => {
    const stateStore = createRuntimeApplicationStateStore();
    await stateStore.save({
      version: "1.0.0",
      runId: "run-1",
      taskId: "task-1",
      applicationUrl: snapshot.url,
      snapshotId: "snapshot-persisted",
      executionEpoch: 7,
      fieldIds: ["field-1"],
      plannedCommandIds: [],
      completedCommandIds: [],
      retryCount: 0,
      finalReviewLocked: false,
      pendingInterrupt: {
        id: "interrupt-persisted",
        kind: "missing_fact",
        reasonCode: "profile_fact_required",
        questionIds: ["field:field-1"],
        evidenceIds: ["evidence:persisted"],
        createdAt: "2026-09-03T00:00:00.000Z",
        runId: "run-1",
        taskId: "task-1",
        stepId: "persisted-step",
        planRevision: 4,
        executionEpoch: 7,
        snapshotId: "snapshot-persisted",
        safetyStateRef: "application:task-1:epoch:7:snapshot:snapshot-persisted"
      },
      updatedAt: "2026-09-03T00:00:00.000Z"
    });
    const agent = createApplicationAgent({
      tools: {} as never,
      evidenceStore: createInMemoryEvidenceStore(),
      stateStore,
      profileRevision: () => 1
    });

    const result = await agent.execute(input(step("different-step")));

    expect(result.status).toBe("interrupted");
    expect(result.pendingInterrupt?.proposedAction).toEqual(expect.objectContaining({
      runId: "run-1",
      taskId: "task-1",
      stepId: "persisted-step",
      planRevision: 4,
      executionEpoch: 7,
      snapshotId: "snapshot-persisted",
      safetyStateRef: "application:task-1:epoch:7:snapshot:snapshot-persisted"
    }));
  });

  it("restores persisted application metadata across runtime steps without an interrupt", async () => {
    const stateStore = createRuntimeApplicationStateStore();
    await stateStore.save({
      version: "1.0.0",
      runId: "run-1",
      taskId: "task-1",
      applicationUrl: snapshot.url,
      snapshotId: "snapshot-persisted",
      executionEpoch: 7,
      fieldIds: ["field-1"],
      plannedCommandIds: [],
      completedCommandIds: ["previous-command"],
      retryCount: 0,
      finalReviewLocked: false,
      updatedAt: "2026-09-03T00:00:00.000Z"
    });

    let plannedEpoch: number | undefined;
    const nextCommand = { ...command, executionEpoch: 8 };
    const tools = {
      observe: vi.fn(async () => snapshot),
      normalize: vi.fn((value: FormSnapshot) => value),
      resolveFields: vi.fn(async () => ({
        token: "resolution-restored-state",
        snapshotId: snapshot.id,
        phase: "deterministic" as const,
        resolutions: []
      })),
      buildPlan: vi.fn(async ({ executionEpoch }: { executionEpoch: number }) => {
        plannedEpoch = executionEpoch;
        return [nextCommand];
      }),
      buildNavigationPlan: vi.fn(async () => undefined),
      authorize: vi.fn(async (value: ExecutableCommand) => value),
      execute: vi.fn(async (value: ExecutableCommand) => ({
        type: "execution_result" as const,
        taskId: value.taskId,
        snapshotId: snapshot.id,
        commandType: value.type as "fill",
        status: "applied" as const,
        actualValue: "value",
        snapshot
      })),
      readback: vi.fn(async () => ({ status: "confirmed" as const, observations: 2, snapshot })),
      fullPageAudit: vi.fn(async ({ snapshot: value }: { snapshot: FormSnapshot }) => ({ snapshot: value, mismatches: [] })),
      invalidate: vi.fn(async () => 8),
      release: vi.fn(async () => undefined)
    };
    const agent = createApplicationAgent({
      tools: tools as never,
      evidenceStore: createInMemoryEvidenceStore(),
      stateStore,
      profileRevision: () => 1
    });

    const result = await agent.execute({ ...input(step("fill_application")), executionEpoch: 1 });

    expect(result.status).toBe("completed");
    expect(plannedEpoch).toBe(8);
  });
});
