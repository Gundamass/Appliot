import type { FormField, FormSnapshot, WorkerResponse } from "@resume/contracts";
import { describe, expect, it, vi } from "vitest";
import { createApplicationTools } from "./application-tools.js";

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

function executionResult(commandType: "fill" | "select" | "upload" | "click_intermediate", page: FormSnapshot): Extract<WorkerResponse, { type: "execution_result" }> {
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

function createHarness(options: {
  snapshots?: FormSnapshot[];
  executionSnapshot?: FormSnapshot;
} = {}) {
  const snapshots = [...(options.snapshots ?? [snapshot()])];
  const browser = {
    observe: vi.fn(async () => snapshots.shift() ?? snapshot()),
    execute: vi.fn(async (command) => executionResult(command.type, options.executionSnapshot ?? snapshot({
      id: "snapshot-executed",
      fields: [field({ currentValue: "me@example.com" })]
    }))),
    invalidateExecution: vi.fn(async () => undefined),
    releaseTask: vi.fn(async () => undefined)
  };
  const tools = createApplicationTools({
    browser,
    resolveField: async () => ({
      status: "verified" as const,
      value: "me@example.com",
      fieldPath: "basics.email",
      assessment: {
        fieldId: "field-email",
        label: "Email",
        semantic: "basics.email",
        status: "ready" as const,
        source: "exact" as const,
        confidence: 1,
        reason: "evidence_backed",
        evidence: []
      }
    }),
    approve: () => "approved-token"
  });
  return { browser, tools };
}

describe("ApplicationTools", () => {
  it.each([
    ["stale snapshot", async () => {
      const first = snapshot();
      const second = snapshot({ id: "snapshot-2" });
      const { tools } = createHarness({ snapshots: [first, second] });
      const observed = await tools.observe(taskId);
      const resolutions = await tools.resolveFields({
        taskId,
        snapshot: observed,
        profileRevision: 1,
        phase: "deterministic"
      });
      const [draft] = await tools.buildPlan({ taskId, snapshot: observed, resolutions, executionEpoch: 1 });
      await tools.observe(taskId);
      await expect(tools.authorize(draft!, observed)).rejects.toThrow("stale_snapshot");
    }],
    ["NodeRef mismatch", async () => {
      const { tools } = createHarness();
      const observed = await tools.observe(taskId);
      const resolutions = await tools.resolveFields({
        taskId,
        snapshot: observed,
        profileRevision: 1,
        phase: "deterministic"
      });
      const [draft] = await tools.buildPlan({ taskId, snapshot: observed, resolutions, executionEpoch: 1 });
      await expect(tools.authorize({ ...draft!, nodeRef: nodeRef("node-other") }, observed))
        .rejects.toThrow("node_ref_mismatch");
    }],
    ["unapproved command", async () => {
      const { tools } = createHarness();
      const observed = await tools.observe(taskId);
      const resolutions = await tools.resolveFields({
        taskId,
        snapshot: observed,
        profileRevision: 1,
        phase: "deterministic"
      });
      const [draft] = await tools.buildPlan({ taskId, snapshot: observed, resolutions, executionEpoch: 1 });
      await expect(tools.execute(draft!)).rejects.toThrow("command_not_authorized");
    }],
    ["stale execution epoch", async () => {
      const { tools } = createHarness();
      const observed = await tools.observe(taskId);
      const resolutions = await tools.resolveFields({
        taskId,
        snapshot: observed,
        profileRevision: 1,
        phase: "deterministic"
      });
      const [draft] = await tools.buildPlan({ taskId, snapshot: observed, resolutions, executionEpoch: 1 });
      const approved = await tools.authorize(draft!, observed);
      await tools.invalidate(taskId);
      await expect(tools.execute(approved)).rejects.toThrow("stale_execution_epoch");
    }]
  ])("rejects %s at the tool boundary", async (_name, verify) => {
    await verify();
  });

  it("detects a controlled-component false write on the first stable readback", async () => {
    const initial = snapshot();
    const reverted = snapshot({
      id: "snapshot-reverted",
      fields: [field({ currentValue: "" })]
    });
    const { browser, tools } = createHarness({ snapshots: [initial, reverted, reverted] });
    const observed = await tools.observe(taskId);
    const resolutions = await tools.resolveFields({
      taskId,
      snapshot: observed,
      profileRevision: 1,
      phase: "deterministic"
    });
    const [draft] = await tools.buildPlan({ taskId, snapshot: observed, resolutions, executionEpoch: 1 });
    const approved = await tools.authorize(draft!, observed);
    await tools.execute(approved);

    await expect(tools.readback(taskId, [approved])).resolves.toMatchObject({
      status: "mismatch",
      observation: 1,
      code: "controlled_value_reverted"
    });
    expect(browser.observe).toHaveBeenCalledTimes(2);
  });

  it("requires two stable matching observations before confirming a write", async () => {
    const initial = snapshot();
    const filled = snapshot({
      id: "snapshot-filled",
      fields: [field({ currentValue: "me@example.com" })]
    });
    const { browser, tools } = createHarness({ snapshots: [initial, filled, filled] });
    const observed = await tools.observe(taskId);
    const resolutions = await tools.resolveFields({
      taskId,
      snapshot: observed,
      profileRevision: 1,
      phase: "deterministic"
    });
    const [draft] = await tools.buildPlan({ taskId, snapshot: observed, resolutions, executionEpoch: 1 });
    const approved = await tools.authorize(draft!, observed);
    await tools.execute(approved);

    await expect(tools.readback(taskId, [approved])).resolves.toMatchObject({
      status: "confirmed",
      observations: 2,
      snapshot: { id: "snapshot-filled" }
    });
    expect(browser.observe).toHaveBeenCalledTimes(3);
  });

  it("uses a persisted approved content review before resolving the field again", async () => {
    const contentField = field({ id: "self-evaluation", semanticHint: "selfEvaluation" });
    const page = snapshot({ fields: [contentField] });
    const resolveField = vi.fn(async () => ({
      status: "verified" as const,
      value: "Generated draft",
      requiresContentReview: true
    }));
    const resolveApprovedContent = vi.fn(async () => "Approved draft");
    const tools = createApplicationTools({
      browser: {
        observe: vi.fn(async () => page),
        execute: vi.fn(async (command) => executionResult(command.type, page))
      },
      resolveField,
      resolveApprovedContent,
      approve: () => "approved-token"
    });

    const observed = await tools.observe(taskId);
    const resolutions = await tools.resolveFields({
      taskId,
      snapshot: observed,
      profileRevision: 1,
      phase: "deterministic"
    });

    expect(resolutions.resolutions).toEqual([expect.objectContaining({
      field: contentField,
      status: "verified",
      value: "Approved draft"
    })]);
    expect(resolveApprovedContent).toHaveBeenCalledWith(taskId, contentField);
    expect(resolveField).not.toHaveBeenCalled();
  });

  it("never creates a submit command from a terminal page action", async () => {
    const terminalPage = snapshot({ fields: [] });
    const { browser, tools } = createHarness({ snapshots: [terminalPage] });
    const observed = await tools.observe(taskId);
    const resolutions = await tools.resolveFields({
      taskId,
      snapshot: observed,
      profileRevision: 1,
      phase: "deterministic"
    });

    await expect(tools.buildPlan({ taskId, snapshot: observed, resolutions, executionEpoch: 1 }))
      .resolves.toEqual([]);
    await expect(tools.buildNavigationPlan({ taskId, snapshot: observed, executionEpoch: 1 }))
      .resolves.toBeUndefined();
    expect(browser.execute).not.toHaveBeenCalled();
  });
});
