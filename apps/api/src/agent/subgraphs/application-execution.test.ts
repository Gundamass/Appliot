import type {
  AgentGraphState,
  ExecutableCommand,
  FormField,
  FormSnapshot,
  HumanInterrupt,
  WorkerResponse
} from "@resume/contracts";
import { describe, expect, it, vi } from "vitest";
import type {
  ApplicationTools,
  FieldResolutionBatch,
  ReadbackResult
} from "../application-tools.js";
import type { TraceSink } from "../trace-sink.js";
import { createFieldCoverageStore } from "../../applications/field-coverage.js";
import { createApplicationExecutionSubgraph } from "./application-execution.js";

const taskId = "task-1";

function nodeRef(nodeId: string) {
  return {
    documentId: "document-application-0001",
    nodeId,
    observedAt: 4
  };
}

function field(overrides: Partial<FormField> = {}): FormField {
  return {
    id: "field-email",
    label: "Email",
    type: "text",
    required: true,
    options: [],
    currentValue: "",
    semanticHint: "basics.email",
    sectionHint: "basics",
    nodeRef: nodeRef("node-field-email"),
    ...overrides
  };
}

function snapshot(overrides: Partial<FormSnapshot> = {}): FormSnapshot {
  return {
    id: "snapshot-1",
    taskId,
    url: "https://jobs.example.test/application",
    title: "Application",
    stage: "application_form",
    frameRef: { documentId: "document-application-0001", kind: "main" },
    mutationEpoch: 4,
    fields: [field()],
    actions: [{
      id: "action-submit",
      text: "Submit application",
      class: "terminal_submit",
      nodeRef: nodeRef("node-action-submit")
    }],
    errors: [],
    ...overrides
  };
}

function state(overrides: Partial<AgentGraphState> = {}): AgentGraphState {
  return {
    threadId: "thread-1",
    runId: "run-1",
    taskId,
    graphVersion: "agent-v1",
    status: "running",
    profileRevision: 1,
    currentSubgraph: "application",
    auditEventIds: [],
    application: {
      applicationUrl: "https://jobs.example.test/application",
      executionEpoch: 0,
      retryCount: 0,
      finalReviewLocked: false
    },
    ...overrides
  };
}

function batch(page: FormSnapshot, kind: "verified" | "missing" | "semantic_review" | "content_review" = "verified"): FieldResolutionBatch {
  const target = page.fields[0] ?? field();
  const resolution = kind === "verified"
    ? {
        field: target,
        status: "verified" as const,
        value: "me@example.com",
        fieldPath: "basics.email",
        assessment: {
          fieldId: target.id,
          label: target.label,
          semantic: "basics.email",
          status: "ready" as const,
          source: "exact" as const,
          confidence: 1,
          reason: "evidence_backed",
          evidence: []
        }
      }
    : kind === "content_review"
      ? {
          field: target,
          status: "verified" as const,
          value: "draft",
          fieldPath: "selfEvaluation",
          requiresContentReview: true,
          assessment: {
            fieldId: target.id,
            label: target.label,
            semantic: "selfEvaluation",
            status: "review" as const,
            source: "exact" as const,
            confidence: 0.8,
            reason: "content_review_required",
            evidence: []
          }
        }
      : {
          field: target,
          status: "needs_question" as const,
          fieldPath: "basics.email",
          question: "Email is required",
          assessment: {
            fieldId: target.id,
            label: target.label,
            semantic: "basics.email",
            status: kind === "semantic_review" ? "review" as const : "missing" as const,
            source: kind === "semantic_review" ? "semantic" as const : "none" as const,
            confidence: 0,
            reason: kind === "semantic_review" ? "ambiguous_candidates" : "profile_fact_required",
            evidence: []
          }
        };
  return { token: `batch-${kind}-${page.id}`, snapshotId: page.id, phase: "deterministic", resolutions: [resolution] };
}

function command(page: FormSnapshot, epoch = 1) {
  return {
    type: "fill" as const,
    taskId,
    snapshotId: page.id,
    fieldId: page.fields[0]?.id ?? "field-email",
    nodeRef: page.fields[0]?.nodeRef ?? nodeRef("node-field-email"),
    executionEpoch: epoch,
    value: "me@example.com",
    approval: "approved"
  };
}

function execution(commandType: "fill" | "select" | "upload" | "click_intermediate", page: FormSnapshot): Extract<WorkerResponse, { type: "execution_result" }> {
  return {
    type: "execution_result",
    taskId,
    snapshotId: page.id,
    commandType,
    status: "applied",
    actualValue: "me@example.com",
    snapshot: page,
    errors: []
  };
}

function traceCollector() {
  const events: Array<{ node: string; reasonCode: string; skill?: import("@resume/contracts").SkillTraceDimensions }> = [];
  const traceSink: TraceSink = {
    record(input) {
      events.push({
        node: input.node,
        reasonCode: input.reasonCode,
        ...(input.skill === undefined ? {} : { skill: input.skill })
      });
      return `trace-${events.length}`;
    },
    list: () => []
  };
  return { events, traceSink };
}

function toolsFixture(options: {
  page?: FormSnapshot;
  resolution?: ReturnType<typeof batch>;
  readbacks?: ReadbackResult[];
  navigation?: ExecutableCommand;
  executionPage?: FormSnapshot;
} = {}) {
  const page = options.page ?? snapshot();
  const execute = vi.fn(async (value: ExecutableCommand) => execution(value.type, options.executionPage ?? page));
  const readback = vi.fn(async (): Promise<ReadbackResult> => options.readbacks?.shift() ?? {
    status: "confirmed" as const,
    observations: 2 as const,
    snapshot: options.executionPage ?? page
  });
  const tools: ApplicationTools = {
    observe: vi.fn(async () => page),
    normalize: vi.fn((value) => value),
    resolveFields: vi.fn(async () => options.resolution ?? batch(page)),
    buildPlan: vi.fn(async () => page.fields.length === 0 ? [] : [command(page)]),
    buildNavigationPlan: vi.fn(async () => options.navigation),
    authorize: vi.fn(async (value) => value),
    execute,
    readback,
    fullPageAudit: vi.fn(async ({ snapshot: current }) => ({ snapshot: current, mismatches: [] })),
    invalidate: vi.fn(async () => 1),
    release: vi.fn(async () => undefined)
  };
  return { tools, execute };
}

describe("application execution subgraph", () => {
  it("invalidates execution before recording a challenge interrupt", async () => {
    const events: string[] = [];
    const challenged = snapshot({ challenge: {
      kind: "captcha",
      detectedAt: "2026-08-22T00:00:00.000Z",
      reasonCode: "captcha_detected"
    } });
    const { tools } = toolsFixture({ page: challenged });
    tools.invalidate = vi.fn(async () => {
      events.push("invalidate");
      return 4;
    });
    const graph = createApplicationExecutionSubgraph({
      tools,
      traceSink: traceCollector().traceSink,
      now: () => new Date("2026-08-22T00:00:00.000Z"),
      onInterrupt: () => events.push("interrupt")
    });

    const result = await graph({ state: state() });

    expect(events).toEqual(["invalidate", "interrupt"]);
    expect(result).toMatchObject({
      status: "interrupted",
      currentNode: "classify_page",
      pendingInterrupt: { kind: "challenge" },
      application: { executionEpoch: 4 }
    });
  });

  it("invalidates execution before interrupting on a challenge during readback", async () => {
    const events: string[] = [];
    const page = snapshot();
    const challenged = snapshot({
      id: "snapshot-readback-challenge",
      challenge: {
        kind: "captcha",
        detectedAt: "2026-08-22T00:00:00.000Z",
        reasonCode: "captcha_detected"
      }
    });
    const { tools } = toolsFixture({
      page,
      readbacks: [{ status: "challenge", snapshot: challenged }]
    });
    tools.invalidate = vi.fn(async () => {
      events.push("invalidate");
      return 4;
    });
    const graph = createApplicationExecutionSubgraph({
      tools,
      traceSink: traceCollector().traceSink,
      now: () => new Date("2026-08-22T00:00:00.000Z"),
      onInterrupt: () => events.push("interrupt")
    });

    await expect(graph({ state: state() })).resolves.toMatchObject({
      status: "interrupted",
      currentNode: "double_readback",
      pendingInterrupt: { kind: "challenge" },
      application: { executionEpoch: 4 }
    });
    expect(events).toEqual(["invalidate", "interrupt"]);
  });

  it.each([
    ["login", snapshot({ stage: "login" as const }), "login"],
    ["final review", snapshot({ stage: "review" as const, fields: [] }), "final_review"]
  ] as const)("routes a %s page to a human interrupt", async (_name, page, kind) => {
    const graph = createApplicationExecutionSubgraph({
      tools: toolsFixture({ page }).tools,
      traceSink: traceCollector().traceSink,
      now: () => new Date("2026-08-22T00:00:00.000Z")
    });

    await expect(graph({ state: state() })).resolves.toMatchObject({
      status: "interrupted",
      pendingInterrupt: { kind }
    });
  });

  it.each([
    ["missing objective fact", "missing", "missing_fact", "profile_fact_required"],
    ["semantic ambiguity", "semantic_review", "field_semantics", "field_semantics_review"],
    ["generated content", "content_review", "content_review", "content_review_required"]
  ] as const)("interrupts for %s before building browser writes", async (_name, resolutionKind, interruptKind, reasonCode) => {
    const page = snapshot();
    const { tools } = toolsFixture({ page, resolution: batch(page, resolutionKind) });
    const graph = createApplicationExecutionSubgraph({
      tools,
      traceSink: traceCollector().traceSink,
      now: () => new Date("2026-08-22T00:00:00.000Z")
    });

    await expect(graph({ state: state() })).resolves.toMatchObject({
      status: "interrupted",
      pendingInterrupt: { kind: interruptKind, reasonCode }
    });
    expect(tools.buildPlan).not.toHaveBeenCalled();
  });

  it("records field coverage and marks the executed field filled after readback", async () => {
    const page = snapshot();
    const coverage = createFieldCoverageStore();
    const { tools } = toolsFixture({ page });
    const graph = createApplicationExecutionSubgraph({
      tools,
      fieldCoverage: coverage,
      traceSink: traceCollector().traceSink,
      now: () => new Date("2026-08-22T00:00:00.000Z")
    });

    await graph({ state: state() });

    expect(coverage.snapshot(taskId)).toMatchObject({
      total: 1,
      filled: 1,
      fields: [expect.objectContaining({ fieldId: "field-email", status: "filled" })]
    });
  });

  it("forwards a generated content draft to the local review store before interrupting", async () => {
    const page = snapshot({ fields: [field({ id: "self-evaluation", label: "Self evaluation" })] });
    const onContentReview = vi.fn();
    const graph = createApplicationExecutionSubgraph({
      tools: toolsFixture({ page, resolution: batch(page, "content_review") }).tools,
      traceSink: traceCollector().traceSink,
      now: () => new Date("2026-08-22T00:00:00.000Z"),
      onContentReview
    });

    await graph({ state: state() });

    expect(onContentReview).toHaveBeenCalledWith(expect.objectContaining({
      taskId,
      interrupt: expect.objectContaining({ kind: "content_review", id: expect.any(String) }),
      review: expect.objectContaining({
        fieldId: "self-evaluation",
        fieldLabel: "Self evaluation",
        original: "draft",
        draft: "draft",
        status: "needs_review"
      })
    }));
  });

  it("executes only a non-final navigation and then locks final review", async () => {
    const application = snapshot({
      fields: [],
      actions: [{
        id: "action-next",
        text: "Continue",
        class: "intermediate_navigation",
        nodeRef: nodeRef("node-action-next")
      }]
    });
    const review = snapshot({ id: "snapshot-review", stage: "review" as const, fields: [] });
    const next = {
      type: "click_intermediate" as const,
      taskId,
      snapshotId: application.id,
      actionId: "action-next",
      nodeRef: nodeRef("node-action-next"),
      executionEpoch: 1,
      approval: "approved"
    };
    const { tools, execute } = toolsFixture({ page: application, navigation: next, executionPage: review });
    const graph = createApplicationExecutionSubgraph({
      tools,
      traceSink: traceCollector().traceSink,
      now: () => new Date("2026-08-22T00:00:00.000Z")
    });

    const result = await graph({ state: state() });

    expect(result).toMatchObject({
      status: "interrupted",
      pendingInterrupt: { kind: "final_review" },
      application: { finalReviewLocked: true }
    });
    expect(tools.execute).toHaveBeenCalledWith(expect.objectContaining({ type: "click_intermediate" }));
    const executedTypes = execute.mock.calls.map(([value]) =>
      (value as unknown as { type?: unknown }).type
    );
    expect(executedTypes).not.toContain("submit");
  });

  it("audits the current page before an intermediate navigation", async () => {
    const application = snapshot({
      fields: [],
      actions: [{
        id: "action-next",
        text: "Continue",
        class: "intermediate_navigation",
        nodeRef: nodeRef("node-action-next")
      }]
    });
    const review = snapshot({ id: "snapshot-review", stage: "review" as const, fields: [] });
    const next = {
      type: "click_intermediate" as const,
      taskId,
      snapshotId: application.id,
      actionId: "action-next",
      nodeRef: nodeRef("node-action-next"),
      executionEpoch: 1,
      approval: "approved"
    };
    const { tools } = toolsFixture({ page: application, navigation: next, executionPage: review });
    const events: string[] = [];
    tools.fullPageAudit = vi.fn(async ({ snapshot: current, reason }) => {
      events.push(`audit:${current.id}:${reason}`);
      return { snapshot: current, mismatches: [] };
    });
    tools.execute = vi.fn(async (value) => {
      events.push(`execute:${value.type}`);
      return execution(value.type, review);
    });
    const graph = createApplicationExecutionSubgraph({
      tools,
      traceSink: traceCollector().traceSink,
      now: () => new Date("2026-08-22T00:00:00.000Z")
    });

    await expect(graph({ state: state() })).resolves.toMatchObject({
      status: "interrupted",
      pendingInterrupt: { kind: "final_review" }
    });

    expect(events).toEqual([
      "audit:snapshot-1:phase_boundary",
      "execute:click_intermediate"
    ]);
  });

  it("retries one failed double-readback and then fails closed", async () => {
    const page = snapshot();
    const firstMismatch: ReadbackResult = {
      status: "mismatch",
      observation: 1,
      code: "controlled_value_reverted",
      snapshot: page,
      mismatches: [{ fieldId: "field-email", expectedValue: "me@example.com", actualValue: "" }]
    };
    const secondMismatch: ReadbackResult = {
      status: "mismatch",
      observation: 2,
      code: "controlled_value_reverted",
      snapshot: page,
      mismatches: [{ fieldId: "field-email", expectedValue: "me@example.com", actualValue: "" }]
    };
    const { tools } = toolsFixture({ page, readbacks: [firstMismatch, secondMismatch] });
    const graph = createApplicationExecutionSubgraph({
      tools,
      traceSink: traceCollector().traceSink,
      now: () => new Date("2026-08-22T00:00:00.000Z")
    });

    await expect(graph({ state: state() })).resolves.toMatchObject({
      status: "failed",
      currentNode: "double_readback",
      error: { code: "READBACK_MISMATCH" },
      application: { retryCount: 1 }
    });
    expect(tools.invalidate).toHaveBeenCalledOnce();
    expect(tools.readback).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending task and rejects a duplicate resume", async () => {
    const pending: HumanInterrupt = {
      id: "interrupt-1",
      kind: "login",
      reasonCode: "login_required",
      questionIds: [],
      evidenceIds: [],
      createdAt: "2026-08-22T00:00:00.000Z"
    };
    const { tools } = toolsFixture();
    const graph = createApplicationExecutionSubgraph({
      tools,
      traceSink: traceCollector().traceSink,
      now: () => new Date("2026-08-22T00:00:00.000Z")
    });
    const interrupted = state({ status: "interrupted", pendingInterrupt: pending });

    await expect(graph({ state: interrupted, resume: {
      interruptId: pending.id,
      action: "cancel",
      values: {}
    } })).resolves.toMatchObject({ status: "cancelled", currentNode: "cancelled" });
    await expect(graph({ state: state({ status: "cancelled" }), resume: {
      interruptId: pending.id,
      action: "confirm",
      values: {}
    } })).resolves.toMatchObject({
      status: "failed",
      error: { code: "application_resume_not_pending" }
    });
    expect(tools.invalidate).toHaveBeenCalledOnce();
    expect(tools.release).toHaveBeenCalledOnce();
  });

  it("fails a rejected content review after invalidating the browser execution", async () => {
    const pending: HumanInterrupt = {
      id: "content-review-1",
      kind: "content_review",
      reasonCode: "content_review_required",
      questionIds: ["field:self-evaluation"],
      evidenceIds: [],
      createdAt: "2026-08-22T00:00:00.000Z"
    };
    const { tools } = toolsFixture();
    const graph = createApplicationExecutionSubgraph({
      tools,
      traceSink: traceCollector().traceSink,
      now: () => new Date("2026-08-22T00:00:00.000Z")
    });

    await expect(graph({ state: state({ status: "interrupted", pendingInterrupt: pending }), resume: {
      interruptId: pending.id,
      action: "reject",
      values: {}
    } })).resolves.toMatchObject({
      status: "failed",
      currentNode: "content_review_rejected",
      error: { code: "content_review_rejected" }
    });

    expect(tools.invalidate).toHaveBeenCalledOnce();
    expect(tools.release).toHaveBeenCalledOnce();
  });

  it("hands an unmatched Skill page off after observation without any browser write", async () => {
    const { tools, execute } = toolsFixture();
    const graph = createApplicationExecutionSubgraph({
      tools,
      traceSink: traceCollector().traceSink,
      skillRuntime: {
        resolve: vi.fn(async () => ({
          kind: "observe_only_handoff" as const,
          reason: "page_unmatched" as const
        }))
      },
      now: () => new Date("2026-09-07T00:00:00.000Z")
    });

    await expect(graph({ state: state() })).resolves.toMatchObject({
      status: "interrupted",
      currentNode: "select_application_skill",
      pendingInterrupt: {
        kind: "field_semantics",
        reasonCode: "application_skill_page_unmatched"
      }
    });
    expect(tools.observe).toHaveBeenCalledOnce();
    expect(tools.resolveFields).not.toHaveBeenCalled();
    expect(tools.buildPlan).not.toHaveBeenCalled();
    expect(tools.authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("pins the selected Skill binding and passes its semantic order into safe plan construction", async () => {
    const page = snapshot();
    const { tools } = toolsFixture({ page });
    const binding = {
      skillId: "baidu-application",
      version: "1.0.0",
      site: "baidu" as const,
      pageFingerprintHash: "b".repeat(64),
      allocationId: "allocation-baidu-campus"
    };
    const trace = traceCollector();
    const graph = createApplicationExecutionSubgraph({
      tools,
      traceSink: trace.traceSink,
      skillRuntime: {
        resolve: vi.fn(async () => ({
          kind: "selected" as const,
          binding,
          pageVariantId: "application-form",
          allocation: "champion" as const,
          directives: [
            { kind: "resolve-field" as const, semantic: "basics.email" as const, locatorKeys: ["candidate-email"] },
            { kind: "verify-field" as const, semantic: "basics.email" as const }
          ]
        }))
      },
      now: () => new Date("2026-09-07T00:00:00.000Z")
    });

    const result = await graph({ state: state() });

    expect(result.application).toMatchObject({
      skillBinding: binding,
      skillTrace: {
        skillId: binding.skillId,
        skillVersion: binding.version,
        pageFingerprintHash: binding.pageFingerprintHash,
        pageVariantId: "application-form",
        allocation: "champion"
      }
    });
    expect(tools.buildPlan).toHaveBeenCalledWith(expect.objectContaining({
      skillSemanticOrder: ["basics.email"]
    }));
    expect(trace.events).toContainEqual(expect.objectContaining({
      node: "select_application_skill",
      skill: {
        skillId: binding.skillId,
        skillVersion: binding.version,
        pageFingerprintHash: binding.pageFingerprintHash,
        pageVariantId: "application-form",
        allocation: "champion"
      }
    }));
  });

  it("fails closed if a resumed task is offered a different Skill binding", async () => {
    const { tools, execute } = toolsFixture();
    const originalBinding = {
      skillId: "baidu-application",
      version: "1.0.0",
      site: "baidu" as const,
      pageFingerprintHash: "b".repeat(64),
      allocationId: "allocation-baidu-campus"
    };
    const graph = createApplicationExecutionSubgraph({
      tools,
      traceSink: traceCollector().traceSink,
      skillRuntime: {
        resolve: vi.fn(async () => ({
          kind: "selected" as const,
          binding: { ...originalBinding, version: "2.0.0" },
          directives: []
        }))
      }
    });

    const result = await graph({ state: state({
      application: {
        applicationUrl: "https://jobs.example.test/application",
        executionEpoch: 0,
        retryCount: 0,
        finalReviewLocked: false,
        skillBinding: originalBinding
      }
    }) });

    expect(result).toMatchObject({
      status: "failed",
      currentNode: "select_application_skill",
      error: { code: "application_skill_binding_changed" },
      application: { skillBinding: originalBinding }
    });
    expect(tools.resolveFields).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
