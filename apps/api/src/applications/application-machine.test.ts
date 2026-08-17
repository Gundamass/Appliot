import Database from "better-sqlite3";
import { ApplicationTaskEventSchema, CertifiedHintPackSchema, type ApplicationFieldAssessment, type ChallengeDiagnostic, type ExecutableCommand, type FormField, type FormSnapshot, type WorkerActivity, type WorkerResponse } from "@resume/contracts";
import { createActor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { applicationMachine, sendApplicationEvent, type ApplicationEvent } from "./application-machine.js";
import { createApplicationService } from "./application-service.js";
import { createCheckpointRepository } from "./checkpoint-repository.js";
import { createTaskEventBus, type TaskEventBus } from "./task-events.js";
import { createApplicationTaskRepository } from "./application-task-repository.js";
import { BrowserOwnershipLease } from "../browser/browser-ownership-lease.js";
const fixtureNodeRef = {
  documentId: "document-fixture-00000001",
  nodeId: "node-fixture-000000000001",
  observedAt: 7
};



type ProgressEventPayload = Parameters<TaskEventBus["emitProgress"]>[1];

const testDocumentId = "document-00000001";
const testMutationEpoch = 7;
const auditTaskId = "task-1";
const testNodeRef = (nodeId: string) => ({
  documentId: testDocumentId,
  nodeId,
  observedAt: testMutationEpoch
});

function captureProgressEvents(progressEvents: ProgressEventPayload[]): Pick<TaskEventBus, "emit" | "emitProgress"> {
  return {
    emit: (_taskId, state) => ({
      type: "state_changed" as const,
      taskId: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
      id: "0",
      state,
      createdAt: "2026-08-03T00:00:00.000Z"
    }),
    emitProgress(_taskId, event) {
      progressEvents.push(event);
      return ApplicationTaskEventSchema.parse({
        ...event,
        taskId: "91dc4bd6-425a-4cab-a38d-d13e33cda771",
        id: "0",
        createdAt: "2026-08-03T00:00:00.000Z"
      });
    }
  };
}

function snapshot(stage: FormSnapshot["stage"], options: { action?: boolean } = {}): FormSnapshot {
  return {
    id: `snapshot-${stage}`,
    taskId: "task-1",
    url: `https://jobs.example.test/${stage}`,
    title: stage === "review" ? "确认申请" : "填写申请",
    stage,
    frameRef: { documentId: testDocumentId, kind: "main" as const },
    mutationEpoch: testMutationEpoch,
    fields: [],
    actions: options.action ? [{
      id: "action-next",
      text: "下一步",
      class: "intermediate_navigation",
      nodeRef: testNodeRef("node-action-next")
    }] : stage === "review" ? [{
      id: "action-submit",
      text: "提交申请",
      class: "terminal_submit",
      nodeRef: testNodeRef("node-action-submit")
    }] : [],
    errors: []
  };
}

function auditedField(index: number): FormField {
  return {
    id: `field-${index}`,
    label: `Field ${index}`,
    type: "text",
    required: true,
    options: [],
    currentValue: "",
    sectionHint: "basics",
    semanticHint: `basics.field${index}`,
    nodeRef: testNodeRef(`node-field-${String(index).padStart(8, "0")}`)
  };
}

function readyAssessment(field: FormField): ApplicationFieldAssessment {
  return {
    fieldId: field.id,
    label: field.label,
    semantic: field.semanticHint,
    status: "ready",
    source: "exact",
    confidence: 1,
    reason: "test-ready",
    evidence: []
  };
}

describe("application machine", () => {
  it.each([
    ["observing", []],
    ["awaiting_login", [{ type: "LOGIN_REQUIRED" }]],
    ["needs_questions", [{ type: "QUESTIONS_REQUIRED", questions: [] }]],
    ["awaiting_content_review", [{ type: "CONTENT_REVIEW_REQUIRED" }]],
    ["filling", [{ type: "READY_TO_FILL" }]],
    ["validating", [{ type: "READY_TO_FILL" }, { type: "PAGE_FILLED" }]],
    ["navigating", [{ type: "READY_TO_FILL" }, { type: "PAGE_FILLED" }, { type: "PAGE_VALID" }]]
  ] satisfies Array<[string, ApplicationEvent[]]>)
  ("enters a persistent challenge pause from %s", (_state, setupEvents) => {
    const actor = createActor(applicationMachine, {
      input: { taskId: "task-challenge", applicationUrl: "https://jobs.example.test/apply" }
    }).start();
    const challenge: ChallengeDiagnostic = {
      kind: "captcha",
      detectedAt: "2026-08-15T00:00:00.000Z",
      reasonCode: "moka_captcha_accessible_name"
    };
    sendApplicationEvent(actor, { type: "START" });
    setupEvents.forEach((event) => sendApplicationEvent(actor, event));

    sendApplicationEvent(actor, { type: "CHALLENGE_DETECTED", challenge });

    expect(actor.getSnapshot().value).toBe("awaiting_challenge");
    expect(actor.getSnapshot().context.challenge).toEqual(challenge);
    for (const ignored of [
      { type: "READY_TO_FILL" },
      { type: "RECOVER" },
      { type: "PAGE_VALID" },
      { type: "CHALLENGE_DETECTED", challenge: { ...challenge, kind: "risk_control" as const } }
    ] satisfies ApplicationEvent[]) {
      actor.send(ignored);
      expect(actor.getSnapshot().value).toBe("awaiting_challenge");
      expect(actor.getSnapshot().context.challenge).toEqual(challenge);
    }

    sendApplicationEvent(actor, { type: "USER_RESUME_CHALLENGE" });
    expect(actor.getSnapshot().value).toBe("observing");
    expect(actor.getSnapshot().context.challenge).toBeUndefined();
    actor.stop();
  });

  it("pauses an unknown application page for adapter review", () => {
    const actor = createActor(applicationMachine, {
      input: { taskId: "task-adapter-review", applicationUrl: "https://unknown.test/apply" }
    }).start();

    sendApplicationEvent(actor, { type: "START" });
    sendApplicationEvent(actor, { type: "ADAPTER_REVIEW_REQUIRED" });

    expect(actor.getSnapshot().value).toBe("awaiting_adapter_review");
    expect(actor.getSnapshot().can({ type: "READY_TO_FILL" })).toBe(false);
    actor.stop();
  });

  it.each([
    ["filling", [{ type: "READY_TO_FILL" }]],
    ["validating", [{ type: "READY_TO_FILL" }, { type: "PAGE_FILLED" }]],
    ["navigating", [{ type: "READY_TO_FILL" }, { type: "PAGE_FILLED" }, { type: "PAGE_VALID" }]]
  ] satisfies Array<[string, ApplicationEvent[]]>)
  ("quarantines an active certified pack from %s", (_state, setupEvents) => {
    const actor = createActor(applicationMachine, {
      input: { taskId: "task-adapter-quarantine", applicationUrl: "https://known.test/apply" }
    }).start();
    sendApplicationEvent(actor, { type: "START" });
    setupEvents.forEach((event) => sendApplicationEvent(actor, event));

    sendApplicationEvent(actor, { type: "ADAPTER_REVIEW_REQUIRED" });

    expect(actor.getSnapshot().value).toBe("awaiting_adapter_review");
    actor.stop();
  });

  it.each([
    ["awaiting_login", [{ type: "LOGIN_REQUIRED" }]],
    ["needs_questions", [{ type: "QUESTIONS_REQUIRED", questions: [] }]],
    ["awaiting_content_review", [{ type: "CONTENT_REVIEW_REQUIRED" }]]
  ] satisfies Array<[string, ApplicationEvent[]]>)
  ("quarantines an observed page from %s before it can resume", (_state, setupEvents) => {
    const actor = createActor(applicationMachine, {
      input: { taskId: "task-adapter-pre-fill", applicationUrl: "https://known.test/apply" }
    }).start();
    sendApplicationEvent(actor, { type: "START" });
    setupEvents.forEach((event) => sendApplicationEvent(actor, event));

    sendApplicationEvent(actor, { type: "ADAPTER_REVIEW_REQUIRED" });

    expect(actor.getSnapshot().value).toBe("awaiting_adapter_review");
    actor.stop();
  });

  it("invalidates execution and performs zero writes for an unmatched ATS", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      url: "https://unknown.test/apply",
      fields: [{
        id: "unknown-name",
        label: "Full name",
        type: "text",
        required: true,
        options: [],
        currentValue: "",
        nodeRef: fixtureNodeRef
      }]
    };
    const invalidateExecution = vi.fn(async () => undefined);
    const execute = vi.fn();
    const resolveField = vi.fn(async () => ({ status: "verified" as const, value: "not-written" }));
    const prepare = vi.fn(async () => ({
      replayReports: [],
      lifecycleStatus: "candidate" as const,
      aiReviewUnavailable: false,
      writeBlocked: true as const
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute, invalidateExecution },
      resolveField,
      approve: () => "approved-token",
      hintPackRegistry: {
        resolve: () => ({ kind: "review_only" as const, reason: "no_certified_pack" as const, mismatchedPacks: [] }),
        listCertified: () => []
      },
      adapterReviewService: { prepare, retire: vi.fn() }
    });
    service.start({ taskId: "task-adapter-review", applicationUrl: form.url });

    await service.runUntilPause("task-adapter-review");

    expect(service.state("task-adapter-review").value).toBe("awaiting_adapter_review");
    expect(invalidateExecution).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(resolveField).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledWith("task-adapter-review", form);
    database.close();
  });

  it("expands a repeated section from the active certified pack action rule", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{
        id: "prefilled-name",
        label: "Name",
        type: "text",
        required: true,
        options: [],
        currentValue: "Already filled",
        semanticHint: "basics.name",
        nodeRef: fixtureNodeRef
      }],
      actions: [{
        id: "custom-add-project",
        text: "Add another record",
        class: "safe_edit",
        context: "Portfolio history",
        nodeRef: fixtureNodeRef
      }]
    };
    const pack = CertifiedHintPackSchema.parse({
      schemaVersion: 1,
      packId: "test-custom-repeat-pack",
      version: "1.0.0",
      match: {
        sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/"] }],
        stages: ["application_form"],
        requiredTextSignals: [],
        pageFingerprintHashes: []
      },
      sectionRules: [{ section: "projects", headingAliases: ["Portfolio history"], fieldOrderAliases: [] }],
      fieldRules: [],
      actionRules: [{ kind: "add_repeated_entry", verbs: ["Add another"], sections: ["projects"] }],
      fixtures: [{ fixtureId: "test-custom-repeat", expectedProfilePaths: ["projects[0].name"] }],
      lifecycleStatus: "certified",
      certifiedAt: "2026-08-17T00:00:00.000Z",
      provenance: {
        proposalId: "test-custom-repeat-proposal",
        replayReportIds: ["test-custom-repeat-replay"],
        humanReviewId: "test-custom-repeat-human-review"
      }
    });
    const execute = vi.fn(async () => ({
      type: "execution_result" as const,
      taskId: "task-1",
      snapshotId: form.id,
      commandType: "click_intermediate" as const,
      status: "applied" as const,
      actualValue: undefined,
      snapshot: form,
      errors: []
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified" as const, value: "unused" }),
      approve: () => "approved-token",
      listProfileFacts: () => [{
        id: "project-0",
        fieldPath: "projects[0].name",
        value: "Project",
        status: "user_confirmed" as const,
        confidence: 1,
        scope: "profile" as const,
        revision: 1,
        evidence: []
      }],
      hintPackRegistry: {
        resolve: () => ({ kind: "certified" as const, pack }),
        listCertified: () => [pack]
      },
      adapterReviewService: {
        prepare: async () => ({
          replayReports: [],
          lifecycleStatus: "candidate" as const,
          aiReviewUnavailable: false,
          writeBlocked: true as const
        }),
        retire: vi.fn()
      }
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      type: "click_intermediate",
      actionId: "custom-add-project"
    }), expect.any(Number));
    database.close();
  });

  it("quarantines a post-fill snapshot that no longer matches the certified pack", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const initial: FormSnapshot = {
      ...snapshot("application_form"),
      id: "known-snapshot",
      fields: [
        {
          id: "first-field",
          label: "First field",
          type: "text",
          required: true,
          options: [],
          currentValue: "",
          sectionHint: "basics",
          nodeRef: fixtureNodeRef
        },
        {
          id: "second-field",
          label: "Second field",
          type: "text",
          required: true,
          options: [],
          currentValue: "",
          sectionHint: "basics",
          nodeRef: fixtureNodeRef
        }
      ]
    };
    const drifted: FormSnapshot = {
      ...initial,
      id: "unknown-snapshot",
      url: "https://unknown.test/apply",
      mutationEpoch: fixtureNodeRef.observedAt + 1,
      fields: initial.fields.map((field, index) => ({
        ...field,
        semanticHint: index === 0 ? "basics.name" : "basics.phone"
      }))
    };
    const pack = CertifiedHintPackSchema.parse({
      schemaVersion: 1,
      packId: "test-fill-pack",
      version: "1.0.0",
      match: {
        sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/"] }],
        stages: ["application_form"],
        requiredTextSignals: [],
        pageFingerprintHashes: []
      },
      sectionRules: [{ section: "basics", headingAliases: ["Personal details"], fieldOrderAliases: [] }],
      fieldRules: [
        {
          ruleId: "first-field",
          profilePath: "basics.name",
          labelAliases: ["First field"],
          sections: ["basics"],
          controlTypes: ["text"],
          confidence: 1
        },
        {
          ruleId: "second-field",
          profilePath: "basics.phone",
          labelAliases: ["Second field"],
          sections: ["basics"],
          controlTypes: ["text"],
          confidence: 1
        }
      ],
      actionRules: [],
      fixtures: [{ fixtureId: "test-fill", expectedProfilePaths: ["basics.name", "basics.phone"] }],
      lifecycleStatus: "certified",
      certifiedAt: "2026-08-17T00:00:00.000Z",
      provenance: {
        proposalId: "test-fill-proposal",
        replayReportIds: ["test-fill-replay"],
        humanReviewId: "test-fill-human-review"
      }
    });
    const prepare = vi.fn(async () => ({
      replayReports: [],
      lifecycleStatus: "candidate" as const,
      aiReviewUnavailable: false,
      writeBlocked: true as const
    }));
    const invalidateExecution = vi.fn(async () => undefined);
    const execute = vi.fn(async (command: ExecutableCommand) => ({
      type: "execution_result" as const,
      taskId: command.taskId,
      snapshotId: initial.id,
      commandType: command.type,
      status: "applied" as const,
      actualValue: "written",
      snapshot: drifted,
      errors: []
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => initial, execute, invalidateExecution },
      resolveField: async (_taskId, field) => ({ status: "verified" as const, value: field.id }),
      approve: () => "approved-token",
      hintPackRegistry: {
        resolve: (observed) => observed.url === initial.url
          ? { kind: "certified" as const, pack }
          : { kind: "review_only" as const, reason: "no_certified_pack" as const, mismatchedPacks: [] },
        listCertified: () => [pack]
      },
      adapterReviewService: { prepare, retire: vi.fn() }
    });
    service.start({ taskId: "task-1", applicationUrl: initial.url });

    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("awaiting_adapter_review");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(invalidateExecution).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith("task-1", drifted);
    database.close();
  });

  it("retires the active pack after a full-page readback mismatch", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const initial: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{
        id: "audit-field",
        label: "Audited field",
        type: "text",
        required: true,
        options: [],
        currentValue: "",
        sectionHint: "basics",
        nodeRef: fixtureNodeRef
      }],
      actions: [{
        id: "review-action",
        text: "Review",
        class: "terminal_submit",
        nodeRef: fixtureNodeRef
      }]
    };
    const filled: FormSnapshot = {
      ...initial,
      id: "filled-snapshot",
      fields: initial.fields.map((field) => ({
        ...field,
        currentValue: "written",
        semanticHint: "basics.name"
      }))
    };
    const reverted: FormSnapshot = {
      ...initial,
      id: "reverted-snapshot",
      fields: initial.fields.map((field) => ({ ...field, semanticHint: "basics.name" }))
    };
    const pack = CertifiedHintPackSchema.parse({
      schemaVersion: 1,
      packId: "test-audit-pack",
      version: "1.0.0",
      match: {
        sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/"] }],
        stages: ["application_form"],
        requiredTextSignals: [],
        pageFingerprintHashes: []
      },
      sectionRules: [{ section: "basics", headingAliases: ["Personal details"], fieldOrderAliases: [] }],
      fieldRules: [{
        ruleId: "audit-field",
        profilePath: "basics.name",
        labelAliases: ["Audited field"],
        sections: ["basics"],
        controlTypes: ["text"],
        confidence: 1
      }],
      actionRules: [],
      fixtures: [{ fixtureId: "test-audit", expectedProfilePaths: ["basics.name"] }],
      lifecycleStatus: "certified",
      certifiedAt: "2026-08-17T00:00:00.000Z",
      provenance: {
        proposalId: "test-audit-proposal",
        replayReportIds: ["test-audit-replay"],
        humanReviewId: "test-audit-human-review"
      }
    });
    const prepare = vi.fn(async () => ({
      replayReports: [],
      lifecycleStatus: "candidate" as const,
      aiReviewUnavailable: false,
      writeBlocked: true as const
    }));
    const retire = vi.fn();
    const invalidateExecution = vi.fn(async () => undefined);
    const execute = vi.fn(async (command: ExecutableCommand) => ({
      type: "execution_result" as const,
      taskId: command.taskId,
      snapshotId: initial.id,
      commandType: command.type,
      status: "applied" as const,
      actualValue: "written",
      snapshot: filled,
      errors: []
    }));
    const observe = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(reverted);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute, invalidateExecution },
      resolveField: async () => ({ status: "verified" as const, value: "written" }),
      approve: () => "approved-token",
      hintPackRegistry: {
        resolve: () => ({ kind: "certified" as const, pack }),
        listCertified: () => [pack]
      },
      adapterReviewService: { prepare, retire }
    });
    service.start({ taskId: "task-1", applicationUrl: initial.url });

    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("awaiting_adapter_review");
    expect(retire).toHaveBeenCalledWith("test-audit-pack", "1.0.0", "unsafe mapping");
    expect(invalidateExecution).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith("task-1", reverted);
    expect(execute).toHaveBeenCalledOnce();
    database.close();
  });

  it.each(["controlled_value_reverted", "node_role_changed"] as const)(
    "retires the active pack instead of retrying a certified-pack regression: %s",
    async (regression) => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{
        id: "regressed-field",
        label: "Regressed field",
        type: "text",
        required: true,
        options: [],
        currentValue: "",
        sectionHint: "basics",
        nodeRef: fixtureNodeRef
      }],
      actions: [{
        id: "review-action",
        text: "Review",
        class: "terminal_submit",
        nodeRef: fixtureNodeRef
      }]
    };
    const pack = CertifiedHintPackSchema.parse({
      schemaVersion: 1,
      packId: "test-regression-pack",
      version: "1.0.0",
      match: {
        sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/"] }],
        stages: ["application_form"],
        requiredTextSignals: [],
        pageFingerprintHashes: []
      },
      sectionRules: [{ section: "basics", headingAliases: ["Personal details"], fieldOrderAliases: [] }],
      fieldRules: [{
        ruleId: "regressed-field",
        profilePath: "basics.name",
        labelAliases: ["Regressed field"],
        sections: ["basics"],
        controlTypes: ["text"],
        confidence: 1
      }],
      actionRules: [],
      fixtures: [{ fixtureId: "test-regression", expectedProfilePaths: ["basics.name"] }],
      lifecycleStatus: "certified",
      certifiedAt: "2026-08-17T00:00:00.000Z",
      provenance: {
        proposalId: "test-regression-proposal",
        replayReportIds: ["test-regression-replay"],
        humanReviewId: "test-regression-human-review"
      }
    });
    const prepare = vi.fn(async () => ({
      replayReports: [],
      lifecycleStatus: "candidate" as const,
      aiReviewUnavailable: false,
      writeBlocked: true as const
    }));
    const retire = vi.fn();
    const execute = vi.fn(async (command: ExecutableCommand) => ({
      type: "execution_result" as const,
      taskId: command.taskId,
      snapshotId: form.id,
      commandType: command.type,
      status: "blocked" as const,
      actualValue: "",
      snapshot: form,
      errors: [regression]
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute, invalidateExecution: vi.fn(async () => undefined) },
      resolveField: async () => ({ status: "verified" as const, value: "written" }),
      approve: () => "approved-token",
      hintPackRegistry: {
        resolve: () => ({ kind: "certified" as const, pack }),
        listCertified: () => [pack]
      },
      adapterReviewService: { prepare, retire }
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("awaiting_adapter_review");
    expect(retire).toHaveBeenCalledWith("test-regression-pack", "1.0.0", "unsafe mapping");
    expect(prepare).toHaveBeenCalledWith("task-1", form);
    expect(execute).toHaveBeenCalledOnce();
      database.close();
    }
  );

  it("requires a fresh execution epoch when resuming after adapter certification", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      actions: [{
        id: "review-action",
        text: "Review",
        class: "terminal_submit",
        nodeRef: fixtureNodeRef
      }]
    };
    const pack = CertifiedHintPackSchema.parse({
      schemaVersion: 1,
      packId: "test-resume-pack",
      version: "1.0.0",
      match: {
        sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/"] }],
        stages: ["application_form"],
        requiredTextSignals: [],
        pageFingerprintHashes: []
      },
      sectionRules: [],
      fieldRules: [],
      actionRules: [],
      fixtures: [{ fixtureId: "test-resume", expectedProfilePaths: ["basics.name"] }],
      lifecycleStatus: "certified",
      certifiedAt: "2026-08-17T00:00:00.000Z",
      provenance: {
        proposalId: "test-resume-proposal",
        replayReportIds: ["test-resume-replay"],
        humanReviewId: "test-resume-human-review"
      }
    });
    let certified = false;
    const invalidateExecution = vi.fn(async () => undefined);
    const execute = vi.fn();
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute, invalidateExecution },
      resolveField: async () => ({ status: "verified" as const, value: "unused" }),
      approve: () => "approved-token",
      hintPackRegistry: {
        resolve: () => certified
          ? { kind: "certified" as const, pack }
          : { kind: "review_only" as const, reason: "no_certified_pack" as const, mismatchedPacks: [] },
        listCertified: () => certified ? [pack] : []
      },
      adapterReviewService: {
        prepare: async () => ({
          replayReports: [],
          lifecycleStatus: "candidate" as const,
          aiReviewUnavailable: false,
          writeBlocked: true as const
        }),
        retire: vi.fn()
      }
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("awaiting_adapter_review");

    certified = true;
    await service.resumeAfterAdapterCertification("task-1");

    expect(invalidateExecution).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("prioritizes a challenge when re-observing after adapter certification", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{
        id: "certification-challenge-field",
        label: "Certification challenge field",
        type: "text",
        required: true,
        options: [],
        currentValue: "",
        nodeRef: fixtureNodeRef
      }]
    };
    const challenged: FormSnapshot = {
      ...form,
      id: "certification-challenge-snapshot",
      challenge: {
        kind: "captcha",
        detectedAt: "2026-08-18T00:00:00.000Z",
        reasonCode: "moka_captcha_accessible_name"
      }
    };
    const pack = CertifiedHintPackSchema.parse({
      schemaVersion: 1,
      packId: "certification-challenge-pack",
      version: "1.0.0",
      match: {
        sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/"] }],
        stages: ["application_form"],
        requiredTextSignals: [],
        pageFingerprintHashes: []
      },
      sectionRules: [],
      fieldRules: [],
      actionRules: [],
      fixtures: [{ fixtureId: "certification-challenge", expectedProfilePaths: ["basics.name"] }],
      lifecycleStatus: "certified",
      certifiedAt: "2026-08-17T00:00:00.000Z",
      provenance: {
        proposalId: "certification-challenge-proposal",
        replayReportIds: ["certification-challenge-replay"],
        humanReviewId: "certification-challenge-human-review"
      }
    });
    let certified = false;
    const invalidateExecution = vi.fn(async () => undefined);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: {
        observe: vi.fn().mockResolvedValueOnce(form).mockResolvedValueOnce(challenged),
        execute: vi.fn(),
        invalidateExecution
      },
      resolveField: async () => ({ status: "needs_question" as const, question: "Required" }),
      approve: () => "approved-token",
      hintPackRegistry: {
        resolve: () => certified
          ? { kind: "certified" as const, pack }
          : { kind: "review_only" as const, reason: "no_certified_pack" as const, mismatchedPacks: [] },
        listCertified: () => certified ? [pack] : []
      },
      adapterReviewService: {
        prepare: async () => ({
          replayReports: [],
          lifecycleStatus: "candidate" as const,
          aiReviewUnavailable: false,
          writeBlocked: true as const
        }),
        retire: vi.fn()
      }
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("awaiting_adapter_review");

    certified = true;
    await service.resumeAfterAdapterCertification("task-1");

    expect(service.state("task-1").value).toBe("awaiting_challenge");
    expect(invalidateExecution).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("prioritizes a challenge over registry review without retiring the active pack", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{
        id: "challenge-field",
        label: "Challenge field",
        type: "text",
        required: true,
        options: [],
        currentValue: "",
        sectionHint: "basics",
        nodeRef: fixtureNodeRef
      }]
    };
    const challenged: FormSnapshot = {
      ...form,
      id: "challenge-snapshot",
      challenge: {
        kind: "captcha",
        detectedAt: "2026-08-18T00:00:00.000Z",
        reasonCode: "moka_captcha_accessible_name"
      }
    };
    const pack = CertifiedHintPackSchema.parse({
      schemaVersion: 1,
      packId: "test-challenge-pack",
      version: "1.0.0",
      match: {
        sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/"] }],
        stages: ["application_form"],
        requiredTextSignals: [],
        pageFingerprintHashes: []
      },
      sectionRules: [{ section: "basics", headingAliases: ["Personal details"], fieldOrderAliases: [] }],
      fieldRules: [{
        ruleId: "challenge-field",
        profilePath: "basics.name",
        labelAliases: ["Challenge field"],
        sections: ["basics"],
        controlTypes: ["text"],
        confidence: 1
      }],
      actionRules: [],
      fixtures: [{ fixtureId: "test-challenge", expectedProfilePaths: ["basics.name"] }],
      lifecycleStatus: "certified",
      certifiedAt: "2026-08-17T00:00:00.000Z",
      provenance: {
        proposalId: "test-challenge-proposal",
        replayReportIds: ["test-challenge-replay"],
        humanReviewId: "test-challenge-human-review"
      }
    });
    const resolve = vi.fn(() => ({ kind: "certified" as const, pack }));
    const prepare = vi.fn(async () => ({
      replayReports: [],
      lifecycleStatus: "candidate" as const,
      aiReviewUnavailable: false,
      writeBlocked: true as const
    }));
    const retire = vi.fn();
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockResolvedValueOnce(challenged);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute: vi.fn(), invalidateExecution: vi.fn(async () => undefined) },
      resolveField: async () => ({ status: "needs_question" as const, question: "Required" }),
      approve: () => "approved-token",
      hintPackRegistry: { resolve, listCertified: () => [pack] },
      adapterReviewService: { prepare, retire }
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("needs_questions");

    await service.handleActivity({ type: "page_stable", taskId: "task-1", fingerprint: "challenge" });

    expect(service.state("task-1").value).toBe("awaiting_challenge");
    expect(resolve).toHaveBeenCalledOnce();
    expect(retire).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    database.close();
  });

  it("retires a pack that fails a fresh fingerprint check before any further write", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const initial: FormSnapshot = {
      ...snapshot("application_form"),
      id: "fingerprint-initial",
      fields: [{
        id: "fingerprint-field",
        label: "Name",
        type: "text",
        required: true,
        options: [],
        currentValue: "",
        nodeRef: fixtureNodeRef
      }]
    };
    const drifted = { ...initial, id: "fingerprint-drifted" };
    const pack = CertifiedHintPackSchema.parse({
      schemaVersion: 1,
      packId: "test-fingerprint-pack",
      version: "1.0.0",
      match: {
        sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/"] }],
        stages: ["application_form"],
        requiredTextSignals: [],
        pageFingerprintHashes: []
      },
      sectionRules: [],
      fieldRules: [],
      actionRules: [],
      fixtures: [{ fixtureId: "test-fingerprint", expectedProfilePaths: ["basics.name"] }],
      lifecycleStatus: "certified",
      certifiedAt: "2026-08-17T00:00:00.000Z",
      provenance: {
        proposalId: "test-fingerprint-proposal",
        replayReportIds: ["test-fingerprint-replay"],
        humanReviewId: "test-fingerprint-human-review"
      }
    });
    const retire = vi.fn();
    const prepare = vi.fn(async () => ({
      replayReports: [],
      lifecycleStatus: "candidate" as const,
      aiReviewUnavailable: false,
      writeBlocked: true as const
    }));
    const resolve = vi.fn((observed: FormSnapshot) => observed.id === initial.id
      ? { kind: "certified" as const, pack }
      : {
          kind: "review_only" as const,
          reason: "fingerprint_mismatch" as const,
          mismatchedPacks: [pack]
        });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: {
        observe: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(drifted),
        execute: vi.fn(),
        invalidateExecution: vi.fn(async () => undefined)
      },
      resolveField: async () => ({ status: "needs_question" as const, question: "Required" }),
      approve: () => "approved-token",
      hintPackRegistry: { resolve, listCertified: () => [pack] },
      adapterReviewService: { prepare, retire }
    });
    service.start({ taskId: "task-1", applicationUrl: initial.url });
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("needs_questions");

    await service.handleActivity({ type: "page_stable", taskId: "task-1", fingerprint: "drift" });

    expect(service.state("task-1").value).toBe("awaiting_adapter_review");
    expect(retire).toHaveBeenCalledWith("test-fingerprint-pack", "1.0.0", "superseded mapping");
    expect(prepare).toHaveBeenCalledWith("task-1", drifted);
    database.close();
  });

  it("uses one observed node and one signed execution epoch for approval and execution", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const nodeRef = testNodeRef("node-field-email");
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{
        id: "field-email",
        label: "邮箱",
        type: "text",
        required: true,
        options: [],
        currentValue: "",
        nodeRef
      }],
      actions: [{
        id: "action-submit",
        text: "提交申请",
        class: "terminal_submit",
        nodeRef: testNodeRef("node-action-submit")
      }]
    };
    const review = snapshot("review");
    const approve = vi.fn((_request: { nodeRef: FormField["nodeRef"]; executionEpoch: number }) => "approved-token");
    const execute = vi.fn(async (command: ExecutableCommand, executionEpoch?: number) => ({
      type: "execution_result" as const,
      taskId: "task-1",
      snapshotId: review.id,
      commandType: command.type,
      status: "applied" as const,
      actualValue: command.type === "fill" ? command.value : "",
      snapshot: review,
      errors: []
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "me@example.com" }),
      approve
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    const approvalRequest = approve.mock.calls[0]?.[0];
    const command = execute.mock.calls[0]?.[0];
    const workerEpoch = execute.mock.calls[0]?.[1];
    expect(approvalRequest).toMatchObject({ nodeRef, executionEpoch: expect.any(Number) });
    expect(command).toMatchObject({ nodeRef, executionEpoch: approvalRequest?.executionEpoch });
    expect(workerEpoch).toBe(approvalRequest?.executionEpoch);
    database.close();
  });

  it("audits after the eighth applied field and never silently refills a reverted value", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const fields = Array.from({ length: 8 }, (_, index) => auditedField(index));
    let page: FormSnapshot = {
      ...snapshot("application_form"),
      fields,
      actions: [{
        id: "action-submit",
        text: "Submit",
        class: "terminal_submit",
        nodeRef: testNodeRef("node-action-submit")
      }]
    };
    const execute = vi.fn(async (command: ExecutableCommand) => {
      const value = command.type === "fill" || command.type === "select" ? command.value : undefined;
      page = {
        ...page,
        id: `snapshot-after-${execute.mock.calls.length}`,
        fields: page.fields.map((candidate) =>
          candidate.id === ("fieldId" in command ? command.fieldId : "")
            ? { ...candidate, currentValue: value }
            : candidate
        )
      };
      return {
        type: "execution_result" as const,
        taskId: auditTaskId,
        snapshotId: page.id,
        commandType: command.type,
        status: "applied" as const,
        actualValue: value,
        snapshot: page,
        errors: []
      };
    });
    const observe = vi.fn(async () => ({
      ...page,
      id: "snapshot-audit-reverted",
      fields: page.fields.map((candidate, index) =>
        index === 0 ? { ...candidate, currentValue: "reverted" } : candidate
      )
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField: async (_taskId, target) => ({
        status: "verified",
        value: `value-${target.id.slice("field-".length)}`,
        fieldPath: target.semanticHint!,
        assessment: readyAssessment(target)
      }),
      approve: () => "approved-token"
    });
    service.start({ taskId: auditTaskId, applicationUrl: page.url });

    await service.runUntilPause(auditTaskId, page);

    expect(execute).toHaveBeenCalledTimes(8);
    expect(observe).toHaveBeenCalledOnce();
    expect(service.fieldCoverage(auditTaskId)).toMatchObject({
      failed: 1,
      fields: expect.arrayContaining([expect.objectContaining({
        fieldId: "field-0",
        status: "failed",
        reason: "controlled_value_reverted"
      })])
    });
    expect(service.progress(auditTaskId)).toMatchObject({
      status: "paused",
      lastResult: { operation: { status: "failed", errorCode: "READBACK_MISMATCH" } }
    });
    database.close();
  });

  it("forces observe-only audits at deterministic, semantic, and final-review boundaries", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const deterministicTarget = auditedField(0);
    const semanticTarget = auditedField(1);
    let page: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [deterministicTarget, semanticTarget],
      actions: [{
        id: "action-submit",
        text: "Submit",
        class: "terminal_submit",
        nodeRef: testNodeRef("node-action-submit")
      }]
    };
    const execute = vi.fn(async (command: ExecutableCommand) => {
      const value = command.type === "fill" || command.type === "select" ? command.value : undefined;
      page = {
        ...page,
        id: "snapshot-after-fill",
        fields: page.fields.map((field) =>
          field.id === ("fieldId" in command ? command.fieldId : "")
            ? { ...field, currentValue: value }
            : field
        )
      };
      return {
        type: "execution_result" as const,
        taskId: auditTaskId,
        snapshotId: page.id,
        commandType: command.type,
        status: "applied" as const,
        actualValue: value,
        snapshot: page,
        errors: []
      };
    });
    const observeAfterExecuteCounts: number[] = [];
    const observe = vi.fn(async () => {
      observeAfterExecuteCounts.push(execute.mock.calls.length);
      return { ...page, id: `snapshot-audit-${observeAfterExecuteCounts.length}` };
    });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField: async (_taskId, field, phase) => field.id === semanticTarget.id
        && phase === "deterministic"
        ? {
            status: "deferred",
            fieldPath: field.semanticHint!,
            assessment: readyAssessment(field)
          }
        : {
            status: "verified",
            value: field.id === deterministicTarget.id ? "value-0" : "value-1",
            fieldPath: field.semanticHint!,
            assessment: readyAssessment(field)
          },
      approve: () => "approved-token"
    });
    service.start({ taskId: auditTaskId, applicationUrl: page.url });

    await service.runUntilPause(auditTaskId, page);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(observeAfterExecuteCounts).toEqual([1, 2, 2]);
    expect(service.state(auditTaskId).value).toBe("review_locked");
    database.close();
  });

  it("passes routed internship profile indexes into field semantic derivation", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "internship-company",
        label: "\u5b9e\u4e60\u5355\u4f4d",
        type: "text",
        required: true,
        options: [],
        currentValue: "",
        sectionHint: "internship"
      }]
    };
    const resolveField = vi.fn(async () => ({ status: "verified" as const, value: undefined }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField,
      listProfileFacts: () => [{
        id: "employment-type-2",
        fieldPath: "work[2].employmentType",
        value: "Java \u540e\u7aef\u5b9e\u4e60",
        status: "user_confirmed" as const,
        confidence: 1,
        scope: "profile" as const,
        revision: 1,
        evidence: []
      }],
      approve: () => "approved"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(resolveField).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ id: "internship-company", semanticHint: "work[2].company" }),
      "deterministic"
    );
    database.close();
  });

  it("deduplicates concurrent run requests for one task", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    let observations = 0;
    const form = snapshot("application_form");
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: {
        observe: async () => {
          observations += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return form;
        },
        execute: vi.fn()
      },
      resolveField: async () => ({ status: "verified" as const, value: undefined }),
      approve: () => "approved"
    });
    service.start({ taskId: "task-dedup", applicationUrl: form.url });

    await Promise.all([
      service.runUntilPause("task-dedup"),
      service.runUntilPause("task-dedup")
    ]);

    expect(observations).toBe(1);
    database.close();
  });

  it("refreshes unresolved application fields after the profile changes", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    let profileHasValue = false;
    let currentValue = "";
    const execute = vi.fn(async (command: ExecutableCommand): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => {
      currentValue = command.type === "fill" ? String(command.value) : currentValue;
      const next = {
        ...snapshot("application_form"),
        fields: [{ nodeRef: fixtureNodeRef, 
          id: "city",
          label: "期望城市",
          type: "text" as const,
          required: true,
          options: [],
          currentValue,
          semanticHint: "preferences.city"
        }]
      };
      return {
        type: "execution_result",
        taskId: command.taskId,
        snapshotId: next.id,
        commandType: command.type,
        status: "applied",
        actualValue: currentValue,
        snapshot: next,
        errors: []
      };
    });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: {
        observe: async () => ({
          ...snapshot("application_form"),
          fields: [{ nodeRef: fixtureNodeRef, 
            id: "city",
            label: "期望城市",
            type: "text" as const,
            required: true,
            options: [],
            currentValue,
            semanticHint: "preferences.city"
          }]
        }),
        execute
      },
      resolveField: async () => profileHasValue
        ? { status: "verified" as const, value: "深圳", fieldPath: "preferences.city" }
        : { status: "needs_question" as const, question: "请补充期望城市", fieldPath: "preferences.city" },
      approve: () => "approved"
    });

    service.start({ taskId: "task-refresh", applicationUrl: "https://jobs.example.test/apply" });
    await service.runUntilPause("task-refresh");
    expect(service.state("task-refresh").value).toBe("needs_questions");
    expect(execute).not.toHaveBeenCalled();

    profileHasValue = true;
    await service.refreshFromProfile();

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      type: "fill",
      fieldId: "city",
      value: "深圳"
    }), expect.any(Number));
    database.close();
  });

  it("persists the applied profile revision and skips a duplicate refresh", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const tasks = createApplicationTaskRepository(database);
    const taskId = "b8e9a1a4-12c9-46fd-bf4b-38dfd87bb7a1";
    tasks.create({ id: taskId, applicationUrl: "https://jobs.example.test/apply" });
    let observations = 0;
    const form = snapshot("review");
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      taskRepository: tasks,
      profileRevision: () => 3,
      browser: {
        observe: async () => {
          observations += 1;
          return form;
        },
        execute: vi.fn()
      },
      resolveField: async () => ({ status: "verified" as const, value: undefined }),
      approve: () => "approved"
    });
    service.start({ taskId, applicationUrl: form.url });

    await service.refreshFromProfile();
    await service.refreshFromProfile();

    expect(observations).toBe(1);
    expect(tasks.get(taskId)).toMatchObject({
      profileRevisionApplied: 3,
      profileSyncStatus: "current"
    });
    database.close();
  });

  it("recovers eligible persisted tasks after the application service is recreated", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const tasks = createApplicationTaskRepository(database);
    const checkpoints = createCheckpointRepository(database);
    const taskId = "c9f0b2b5-23da-47fe-c05c-49e0e98cc8b2";
    tasks.create({ id: taskId, applicationUrl: "https://jobs.example.test/apply" });
    const form = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "name",
        label: "姓名",
        type: "text" as const,
        required: true,
        options: [],
        currentValue: "",
        semanticHint: "basics.name"
      }]
    };
    const first = createApplicationService({
      checkpoints,
      taskRepository: tasks,
      profileRevision: () => 1,
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({
        status: "needs_question" as const,
        question: "请补充信息",
        fieldPath: "basics.name"
      }),
      approve: () => "approved"
    });
    first.start({ taskId, applicationUrl: form.url });
    await first.runUntilPause(taskId);
    expect(first.state(taskId).value).toBe("needs_questions");

    const execute = vi.fn();
    const second = createApplicationService({
      checkpoints,
      taskRepository: tasks,
      profileRevision: () => 1,
      browser: { observe: async () => ({ ...form, stage: "review" as const }), execute },
      resolveField: async () => ({ status: "verified" as const, value: undefined }),
      approve: () => "approved"
    });
    await second.refreshFromProfile();

    expect(second.state(taskId).value).toBe("review_locked");
    expect(tasks.get(taskId)).toMatchObject({
      profileRevisionApplied: 1,
      profileSyncStatus: "current"
    });
    expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), expect.anything());
    database.close();
  });

  it("records an incomplete profile refresh as failed instead of leaving it pending", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const tasks = createApplicationTaskRepository(database);
    const taskId = "daf1c3c6-34eb-48af-d16d-5af1fa9dd9c3";
    tasks.create({ id: taskId, applicationUrl: "https://jobs.example.test/apply" });
    const form = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "name",
        label: "姓名",
        type: "text" as const,
        required: true,
        options: [],
        currentValue: "",
        semanticHint: "basics.name"
      }]
    };
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      taskRepository: tasks,
      profileRevision: () => 2,
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({
        status: "needs_question" as const,
        question: "请补充姓名",
        fieldPath: "basics.name"
      }),
      approve: () => "approved"
    });
    service.start({ taskId, applicationUrl: form.url });

    await service.refreshFromProfile();

    expect(tasks.get(taskId)).toMatchObject({
      profileRevisionApplied: 0,
      profileSyncStatus: "failed",
      profileSyncError: "profile_sync_incomplete"
    });
    database.close();
  });

  it("does not revive terminal application failures during an automatic profile refresh", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const tasks = createApplicationTaskRepository(database);
    const taskId = "eb02d4d7-45fc-49b0-e27e-6b02ab0eead4";
    tasks.create({ id: taskId, applicationUrl: "https://jobs.example.test/apply" });
    const form = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "name",
        label: "姓名",
        type: "text" as const,
        required: true,
        options: [],
        currentValue: "",
        semanticHint: "basics.name"
      }]
    };
    const observe = vi.fn(async () => form);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      taskRepository: tasks,
      profileRevision: () => 2,
      browser: { observe, execute: vi.fn() },
      resolveField: async () => ({ status: "blocked" as const }),
      approve: () => "approved"
    });
    service.start({ taskId, applicationUrl: form.url });
    await service.runUntilPause(taskId);
    expect(service.state(taskId).value).toBe("failed");
    observe.mockClear();

    await service.refreshFromProfile();

    expect(observe).not.toHaveBeenCalled();
    expect(service.state(taskId).value).toBe("failed");
    database.close();
  });

  it("revives a failed task only when the user explicitly synchronizes the profile", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const tasks = createApplicationTaskRepository(database);
    const taskId = "fc13e5f9-67fe-4c2d-9d90-8e8de74d27b0";
    tasks.create({ id: taskId, applicationUrl: "https://jobs.example.test/apply" });
    const applicationForm = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "name",
        label: "姓名",
        type: "text" as const,
        required: true,
        options: [],
        currentValue: "",
        semanticHint: "basics.name"
      }]
    };
    const review = snapshot("review");
    const observe = vi.fn()
      .mockResolvedValueOnce(applicationForm)
      .mockResolvedValueOnce(review);
    const execute = vi.fn();
    let canResolve = false;
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      taskRepository: tasks,
      profileRevision: () => 4,
      browser: { observe, execute },
      resolveField: async () => canResolve
        ? { status: "verified" as const, value: undefined }
        : { status: "blocked" as const },
      approve: () => "approved"
    });
    service.start({ taskId, applicationUrl: applicationForm.url });
    await service.runUntilPause(taskId);
    expect(service.state(taskId).value).toBe("failed");
    observe.mockClear();

    await service.refreshFromProfile();
    expect(observe).not.toHaveBeenCalled();

    canResolve = true;
    await service.syncTaskFromProfile(taskId);

    expect(observe).toHaveBeenCalledOnce();
    expect(service.state(taskId).value).toBe("review_locked");
    expect(tasks.get(taskId)).toMatchObject({
      profileRevisionApplied: 4,
      profileSyncStatus: "current"
    });
    expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), expect.anything());
    database.close();
  });

  it("allows only explicit page transitions and makes review_locked terminal", () => {
    const actor = createActor(applicationMachine, {
      input: { taskId: "task-1", applicationUrl: "https://jobs.example.test/apply" }
    }).start();

    sendApplicationEvent(actor, { type: "START" });
    expect(actor.getSnapshot().value).toBe("observing");
    sendApplicationEvent(actor, { type: "READY_TO_FILL" });
    sendApplicationEvent(actor, { type: "PAGE_FILLED" });
    sendApplicationEvent(actor, { type: "PAGE_VALID" });
    sendApplicationEvent(actor, { type: "PAGE_NAVIGATED" });
    sendApplicationEvent(actor, { type: "REVIEW_REACHED" });
    expect(actor.getSnapshot().value).toBe("review_locked");
    expect(() => sendApplicationEvent(actor, { type: "PAGE_NAVIGATED" })).toThrow("review_locked");
    expect(() => sendApplicationEvent(actor, { type: "CANCEL" })).toThrow("review_locked");
  });

  it("allows a partially filled page to hand unresolved fields to questions", () => {
    const actor = createActor(applicationMachine, {
      input: { taskId: "task-1", applicationUrl: "https://jobs.example.test/apply" }
    }).start();

    sendApplicationEvent(actor, { type: "START" });
    sendApplicationEvent(actor, { type: "READY_TO_FILL" });
    sendApplicationEvent(actor, {
      type: "QUESTIONS_REQUIRED",
      questions: [{
        id: "field-unknown",
        fieldId: "field-unknown",
        fieldPath: "application.jobSpecific",
        label: "培养方式",
        text: "请确认培养方式",
        pageText: "培养方式",
        interpretation: "待确认字段",
        missingInformation: "缺少培养方式",
        scope: "application",
        inputType: "select",
        options: ["统招", "定向"],
        required: true
      }]
    });

    expect(actor.getSnapshot().value).toBe("needs_questions");
  });

  it("returns from a missing-profile question to observing without writing an answer", () => {
    const actor = createActor(applicationMachine, {
      input: { taskId: "task-1", applicationUrl: "https://jobs.example.test/apply" }
    }).start();

    sendApplicationEvent(actor, { type: "START" });
    sendApplicationEvent(actor, { type: "QUESTIONS_REQUIRED", questions: [{
      id: "question-city",
      fieldId: "field-city",
      text: "请补充城市",
      pageText: "期望城市",
      interpretation: "系统识别为投递偏好字段",
      missingInformation: "缺少城市",
      scope: "application",
      inputType: "text",
      options: [],
      required: true
    }] });
    sendApplicationEvent(actor, { type: "PROFILE_UPDATED" });

    expect(actor.getSnapshot().value).toBe("observing");
    expect(actor.getSnapshot().context.questions).toEqual([]);
  });

  it("fills deterministic fields before asking about semantic-only residual fields", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const progressEvents: ProgressEventPayload[] = [];
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" },
        { nodeRef: fixtureNodeRef, id: "field-training", label: "培养方式", type: "select", required: true, options: ["统招", "定向"], currentValue: "" }
      ]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-phone-filled",
      fields: [
        { ...form.fields[0]!, currentValue: "13800000000" },
        form.fields[1]!
      ]
    };
    const execute = vi.fn(async (): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: "task-1",
      snapshotId: filled.id,
      commandType: "fill",
      status: "applied",
      actualValue: "13800000000",
      snapshot: filled,
      errors: []
    }));
    const resolveField = vi.fn(async (
      _taskId: string,
      field: FormField,
      phase?: "deterministic" | "semantic"
    ) => {
      if (field.id === "field-phone") {
        return { status: "verified" as const, value: "13800000000", fieldPath: "basics.phone" };
      }
      return phase === "deterministic"
        ? { status: "deferred" as const }
        : {
            status: "needs_question" as const,
            question: "请确认培养方式",
            fieldPath: "education[0].enrollmentType"
          };
    });
    const service = createApplicationService({
      checkpoints,
      taskEvents: captureProgressEvents(progressEvents),
      browser: { observe: async () => form, execute },
      resolveField,
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      type: "fill",
      fieldId: "field-phone",
      value: "13800000000"
    }), expect.any(Number));
    expect(resolveField).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ id: "field-phone" }),
      "deterministic"
    );
    expect(resolveField).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ id: "field-training" }),
      "semantic"
    );
    expect(service.state("task-1").value).toBe("needs_questions");
    expect(service.state("task-1").context.questions).toHaveLength(1);
    expect(service.state("task-1").context.questions[0]?.fieldId).toBe("field-training");
    const started = progressEvents.filter((event) => event.type === "operation_started");
    expect(started.find((event) => event.progress.fieldId === "field-phone")?.progress.displayPhase).toBe("deterministic_fill");
    database.close();
  });

  it("asks once when multiple required controls share the same semantic path", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { nodeRef: fixtureNodeRef, id: "lab-first", label: "是否有实验室经历", type: "select", required: true, options: ["是", "否"], currentValue: "" },
        { nodeRef: fixtureNodeRef, id: "lab-second", label: "是否有实验室经历", type: "select", required: true, options: ["是", "否"], currentValue: "" }
      ]
    };
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: {
        observe: async () => form,
        execute: vi.fn(async () => { throw new Error("不应执行填写"); })
      },
      resolveField: async (_taskId, field, phase) => phase === "deterministic"
        ? { status: "deferred" as const }
        : {
            status: "needs_question" as const,
            fieldPath: "application.fieldAnswers.laboratoryExperience",
            question: `请补充“${field.label}”`
          },
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(service.state("task-1").context.questions).toHaveLength(1);
    expect(service.state("task-1").context.questions[0]).toMatchObject({
      fieldPath: "application.fieldAnswers.laboratoryExperience",
      label: "是否有实验室经历"
    });
    database.close();
  });

  it("automatically retries a transient safe fill after a matching page readback", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ nodeRef: fixtureNodeRef, id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-phone-filled",
      fields: [{ ...form.fields[0]!, currentValue: "13800000000" }]
    };
    const observe = vi.fn(async () => form);
    const invalidateExecution = vi.fn(async (_taskId: string, _epoch: number) => undefined);
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("transient fill failure"))
      .mockResolvedValueOnce({
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: filled.id,
        commandType: "fill" as const,
        status: "applied" as const,
        actualValue: "13800000000",
        snapshot: filled,
        errors: []
      });
    const service = createApplicationService({
      checkpoints,
      browser: { observe, execute, invalidateExecution },
      resolveField: async () => ({ status: "verified" as const, value: "13800000000" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledTimes(2);
    const firstEpoch = execute.mock.calls[0]?.[1];
    const retryEpoch = execute.mock.calls[1]?.[1];
    const invalidationEpoch = invalidateExecution.mock.calls[0]?.[1];
    expect(firstEpoch).toEqual(expect.any(Number));
    expect(invalidationEpoch).toEqual(expect.any(Number));
    expect(retryEpoch).toEqual(expect.any(Number));
    expect(invalidationEpoch).toBeGreaterThan(firstEpoch!);
    expect(retryEpoch).toBeGreaterThan(invalidationEpoch!);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("does not retry a failed fill after the readback snapshot changes", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ nodeRef: fixtureNodeRef, id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const changedSnapshot: FormSnapshot = { ...form, id: "snapshot-after-page-change" };
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockResolvedValueOnce(changedSnapshot);
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("transient fill failure"))
      .mockRejectedValue(new Error("unexpected retry"));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute, invalidateExecution: vi.fn(async () => undefined) },
      resolveField: async () => ({ status: "verified" as const, value: "13800000000" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.progress("task-1")).toMatchObject({
      status: "paused",
      recovery: ["retry_current", "manual_done", "cancel"]
    });
    database.close();
  });

  it("does not retry a failed fill after the readback shows the target already filled", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ nodeRef: fixtureNodeRef, id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const readback: FormSnapshot = {
      ...form,
      fields: [{ ...form.fields[0]!, currentValue: "13800000000" }]
    };
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockResolvedValueOnce(readback);
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("transient fill failure"))
      .mockRejectedValue(new Error("unexpected retry"));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute, invalidateExecution: vi.fn(async () => undefined) },
      resolveField: async () => ({ status: "verified" as const, value: "13800000000" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.progress("task-1")).toMatchObject({
      status: "paused",
      recovery: ["retry_current", "manual_done", "cancel"]
    });
    database.close();
  });

  it("re-observes and re-resolves once after a non-terminal field execution failure", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-award", label: "赛事名称", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ nodeRef: fixtureNodeRef, id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-award-filled",
      fields: [{ ...form.fields[0]!, currentValue: "全国大学生软件创新大赛一等奖" }]
    };
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockResolvedValueOnce(form)
      .mockResolvedValue(filled);
    const execute = vi.fn()
      .mockResolvedValueOnce({
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: form.id,
        commandType: "fill" as const,
        status: "failed" as const,
        actualValue: "",
        snapshot: form,
        errors: ["field_execution_failed"]
      })
      .mockResolvedValueOnce({
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: filled.id,
        commandType: "fill" as const,
        status: "applied" as const,
        actualValue: "全国大学生软件创新大赛一等奖",
        snapshot: filled,
        errors: []
      });
    const resolveField = vi.fn(async (_taskId: string, _field: FormField, phase?: "deterministic" | "semantic") => ({
      status: "verified" as const,
      value: phase === "semantic" ? "全国大学生软件创新大赛一等奖" : "旧候选值",
      fieldPath: "awards[0].name"
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField,
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(resolveField).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ id: "field-award" }),
      "semantic"
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({
      type: "fill",
      value: "全国大学生软件创新大赛一等奖"
    });
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("re-resolves a field when a dynamic section reuses its id for a different control", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { nodeRef: fixtureNodeRef, id: "field-first", label: "项目名称", type: "text", required: false, options: [], currentValue: "" },
        { nodeRef: fixtureNodeRef, id: "field-reused", label: "项目描述", type: "text", required: false, options: [], currentValue: "" }
      ],
      actions: [{ nodeRef: fixtureNodeRef, id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const shifted: FormSnapshot = {
      ...form,
      id: "snapshot-shifted",
      fields: [
        { ...form.fields[0]!, currentValue: "ApplyPilot" },
        { nodeRef: fixtureNodeRef, id: "field-reused", label: "开始时间 年", type: "select", required: false, options: ["2025"], currentValue: "" }
      ]
    };
    const review = snapshot("review");
    const execute = vi.fn()
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: shifted.id,
        commandType: "fill", status: "applied", actualValue: "ApplyPilot",
        snapshot: shifted, errors: []
      })
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: review.id,
        commandType: "select", status: "applied", actualValue: "2025",
        snapshot: review, errors: []
      });
    const approve = vi.fn((request: { targetId: string; operation: string }, current: FormSnapshot) => {
      const target = current.fields.find((candidate) => candidate.id === request.targetId);
      if (!target) throw new Error("field_not_found");
      if (request.operation === "fill" && target.type === "select") throw new Error("field_operation_mismatch");
      return "approved-token";
    });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async (_taskId, field) => ({
        status: "verified",
        value: field.type === "select" ? "2025" : field.label === "项目名称" ? "ApplyPilot" : "项目描述"
      }),
      approve
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ type: "fill", fieldId: "field-first" });
    expect(execute.mock.calls[1]?.[0]).toMatchObject({ type: "select", fieldId: "field-reused", value: "2025" });
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it.each(["blocked", "failed"] as const)("automatically re-observes and retries a %s browser fill once", async (status) => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ nodeRef: fixtureNodeRef, id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-phone-filled",
      fields: [{ ...form.fields[0]!, currentValue: "13800000000" }]
    };
    const observe = vi.fn(async () => form);
    const execute = vi.fn()
      .mockResolvedValueOnce({
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: form.id,
        commandType: "fill" as const,
        status,
        actualValue: "",
        snapshot: form,
        errors: ["field_not_found"]
      })
      .mockResolvedValueOnce({
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: filled.id,
        commandType: "fill" as const,
        status: "applied" as const,
        actualValue: "13800000000",
        snapshot: filled,
        errors: []
      });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField: async () => ({ status: "verified" as const, value: "13800000000" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(observe).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(service.state("task-1").value).toBe("review_locked");
    expect(service.state("task-1").context.questions).toHaveLength(0);
    database.close();
  });

  it("does not retry a timed-out fill after the page becomes unstable", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ nodeRef: fixtureNodeRef, id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    let releaseReadback!: (value: FormSnapshot) => void;
    const readback = new Promise<FormSnapshot>((resolve) => {
      releaseReadback = resolve;
    });
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockImplementationOnce(async () => readback);
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("transient fill failure"))
      .mockRejectedValue(new Error("unexpected retry"));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField: async () => ({ status: "verified" as const, value: "13800000000" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    const running = service.runUntilPause("task-1");

    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
    await service.handleActivity({ type: "page_unstable", taskId: "task-1", fingerprint: "unstable-page" });
    releaseReadback(form);
    await running;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.progress("task-1")).toMatchObject({
      status: "paused",
      recovery: ["retry_current", "manual_done", "cancel"]
    });
    database.close();
  });

  it("does not pause between deterministic and semantic fills for a delayed page fluctuation", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const progressEvents: ProgressEventPayload[] = [];
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" },
        { nodeRef: fixtureNodeRef, id: "field-award", label: "赛事名称", type: "text", required: true, options: [], currentValue: "" }
      ],
      actions: [{ nodeRef: fixtureNodeRef, id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const phoneFilled: FormSnapshot = {
      ...form,
      id: "snapshot-phone-filled",
      fields: [{ ...form.fields[0]!, currentValue: "13800000000" }, form.fields[1]!]
    };
    const fullyFilled: FormSnapshot = {
      ...phoneFilled,
      id: "snapshot-fully-filled",
      fields: [phoneFilled.fields[0]!, { ...phoneFilled.fields[1]!, currentValue: "全国大学生竞赛" }]
    };
    let releaseSemantic!: () => void;
    const semanticStarted = new Promise<void>((resolveStarted) => {
      releaseSemantic = resolveStarted;
    });
    let semanticRequested!: () => void;
    const semanticRequestedPromise = new Promise<void>((resolve) => {
      semanticRequested = resolve;
    });
    const execute = vi.fn(async (command: ExecutableCommand): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => {
      const next = (command.type === "fill" || command.type === "select") && command.fieldId === "field-award"
        ? fullyFilled
        : phoneFilled;
      return {
        type: "execution_result",
        taskId: "task-1",
        snapshotId: next.id,
        commandType: command.type === "select" ? "select" : "fill",
        status: "applied",
        actualValue: command.type === "fill" ? command.value : "",
        snapshot: next,
        errors: []
      };
    });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      taskEvents: captureProgressEvents(progressEvents),
      browser: {
        observe: vi.fn()
          .mockResolvedValueOnce(form)
          .mockResolvedValue(fullyFilled),
        execute
      },
      resolveField: async (_taskId, field, phase) => {
        if (field.id === "field-phone") return { status: "verified" as const, value: "13800000000" };
        if (phase === "deterministic") return { status: "deferred" as const };
        semanticRequested();
        await semanticStarted;
        return { status: "verified" as const, value: "全国大学生竞赛" };
      },
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    const running = service.runUntilPause("task-1");
    await semanticRequestedPromise;

    expect(service.state("task-1").value).toBe("filling");
    expect(service.progress("task-1")).toMatchObject({ status: "idle", busy: false, recovery: [] });
    await service.handleActivity({ type: "page_unstable", taskId: "task-1", fingerprint: "delayed-first-pass-dom" });

    expect(service.progress("task-1")).toMatchObject({ status: "idle", busy: false, recovery: [] });
    releaseSemantic();
    await running;
    expect(service.state("task-1").value).toBe("review_locked");
    expect(progressEvents.some((event) => event.type === "task_paused")).toBe(false);
    database.close();
  });

  it("publishes deterministic and semantic field fills with distinct workbench phases", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const progressEvents: ProgressEventPayload[] = [];
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      actions: [{ nodeRef: fixtureNodeRef, id: "submit", text: "提交申请", class: "terminal_submit" }],
      fields: [
        { nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" },
        { nodeRef: fixtureNodeRef, id: "field-training", label: "培养方式", type: "select", required: true, options: ["统招", "定向"], currentValue: "" }
      ]
    };
    const phoneFilled: FormSnapshot = {
      ...form,
      id: "snapshot-phone-filled",
      fields: [{ ...form.fields[0]!, currentValue: "13800000000" }, form.fields[1]!]
    };
    const fullyFilled: FormSnapshot = {
      ...form,
      id: "snapshot-fully-filled",
      fields: [{ ...phoneFilled.fields[0]! }, { ...form.fields[1]!, currentValue: "统招" }]
    };
    const execute = vi.fn(async (command: ExecutableCommand): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => {
      const next = (command.type === "fill" || command.type === "select") && command.fieldId === "field-training"
        ? fullyFilled
        : phoneFilled;
      return {
        type: "execution_result",
        taskId: "task-1",
        snapshotId: next.id,
        commandType: command.type === "select" ? "select" : "fill",
        status: "applied",
        actualValue: command.type === "fill" ? command.value : "",
        snapshot: next,
        errors: []
      };
    });
    const service = createApplicationService({
      checkpoints,
      taskEvents: captureProgressEvents(progressEvents),
      browser: { observe: async () => form, execute },
      resolveField: async (_taskId, field, phase) => field.id === "field-phone"
        ? {
            status: "verified",
            value: "13800000000",
            assessment: {
              fieldId: field.id, label: field.label, status: "ready", source: "certified_hint",
              confidence: 1, reason: "认证提示包映射", evidence: [],
              semanticProvenance: {
                packId: "dji-campus",
                packVersion: "1.0.0",
                confidence: 1,
                certification: "certified"
              }
            }
          }
        : phase === "deterministic"
          ? { status: "deferred" }
          : {
              status: "verified",
              value: "统招",
              assessment: {
                fieldId: field.id, label: field.label, status: "ready", source: "semantic",
                confidence: 0.92, reason: "受限语义映射", evidence: []
              }
            },
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    const started = progressEvents.filter((event) => event.type === "operation_started");
    expect(started.find((event) => event.progress.fieldId === "field-phone")?.progress.displayPhase).toBe("deterministic_fill");
    expect(started.find((event) => event.progress.fieldId === "field-training")?.progress.displayPhase).toBe("semantic_fill");
    const executionEvents = progressEvents.filter((event) => event.type === "execution_progress_changed");
    expect(executionEvents.map((event) => event.executionProgress.phases.find((phase) =>
      phase.phase === event.executionProgress.currentPhase)?.status)).toEqual(expect.arrayContaining([
      "running", "completed"
    ]));
    expect(executionEvents.map((event) => event.executionProgress.currentPhase)).toEqual(expect.arrayContaining([
      "deterministic_fill", "semantic_fill", "readback_validation", "final_review"
    ]));
    expect(executionEvents.some((event) => event.executionProgress.currentPhase === "semantic_fill"
      && event.executionProgress.current.action === "正在选择：培养方式"
      && event.executionProgress.current.fieldId === "field-training"
      && event.executionProgress.current.attempt === 1
      && event.executionProgress.current.maxAttempts === 2)).toBe(true);
    expect(service.progress("task-1").executionProgress).toMatchObject({
      currentPhase: "final_review",
      counts: { exact: 1, semantic: 1, user: 0, missing: 0, failed: 0 }
    });
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("persists ordered checkpoints with browser fingerprints", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createCheckpointRepository(database);

    repository.save({
      taskId: "task-1",
      state: "observing",
      url: "https://jobs.example.test/apply",
      stage: "application_form",
      snapshotId: "snapshot-1",
      fieldIds: ["field-email"],
      questions: []
    });
    repository.save({
      taskId: "task-1",
      state: "review_locked",
      url: "https://jobs.example.test/review",
      stage: "review",
      snapshotId: "snapshot-2",
      fieldIds: [],
      questions: []
    });

    expect(repository.latest("task-1")).toMatchObject({
      sequence: 2,
      state: "review_locked",
      snapshotId: "snapshot-2"
    });
    expect(repository.list("task-1").map((checkpoint) => checkpoint.sequence)).toEqual([1, 2]);
    database.close();
  });

  it("persists the full snapshot and pending content review", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const repository = createCheckpointRepository(database);
    const page = snapshot("application_form");

    repository.save({
      taskId: "task-1",
      state: "awaiting_content_review",
      url: page.url,
      stage: page.stage,
      snapshotId: page.id,
      fieldIds: [],
      questions: [],
      snapshot: page,
      contentReview: {
        id: "review-1",
        taskId: "task-1",
        fieldId: "self",
        fieldLabel: "自我评价",
        original: "原始内容",
        draft: "待审核草稿",
        reasons: ["需要确认"],
        evidence: [],
        unsupportedClaims: [],
        status: "needs_review"
      }
    });

    const reopened = createCheckpointRepository(database).latest("task-1");
    expect(reopened?.snapshot).toEqual(page);
    expect(reopened?.contentReview).toMatchObject({ id: "review-1", draft: "待审核草稿" });
    database.close();
  });

  it("automates an intermediate click and locks immediately on the review snapshot", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form = snapshot("application_form", { action: true });
    const review = snapshot("review");
    const observe = vi.fn(async () => form);
    const execute = vi.fn(async (): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: "task-1",
      snapshotId: review.id,
      commandType: "click_intermediate",
      status: "applied",
      actualValue: review.url,
      snapshot: review,
      errors: []
    }));
    const service = createApplicationService({
      checkpoints,
      browser: { observe, execute },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("review_locked");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      type: "click_intermediate",
      actionId: "action-next"
    }), expect.any(Number));
    await expect(service.requestIntermediateClick("task-1", "action-submit")).rejects.toThrow("review_locked");
    expect(checkpoints.latest("task-1")?.state).toBe("review_locked");
    database.close();
  });

  it("uploads the available resume before asking about fields that the site may parse from it", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { nodeRef: fixtureNodeRef, id: "field-resume", label: "上传简历", type: "file", required: false, options: [], currentValue: "" },
        { nodeRef: fixtureNodeRef, id: "field-name", label: "姓名", type: "text", required: true, options: [], currentValue: "" }
      ]
    };
    const parsed: FormSnapshot = {
      ...form,
      id: "snapshot-parsed",
      fields: [
        { ...form.fields[0]!, currentValue: "resume.pdf" },
        { ...form.fields[1]!, currentValue: "张三" }
      ]
    };
    const execute = vi.fn(async (): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: "task-1",
      snapshotId: parsed.id,
      commandType: "upload",
      status: "applied",
      actualValue: "resume.pdf",
      snapshot: parsed,
      errors: []
    }));
    const resolveField = vi.fn(async () => ({
      status: "needs_question" as const,
      question: "知识库中没有该字段"
    }));
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute },
      resolveField,
      resolveFileId: () => "resume-file-1",
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      type: "upload", fieldId: "field-resume", fileId: "resume-file-1"
    }), expect.any(Number));
    expect(resolveField).not.toHaveBeenCalled();
    expect(service.state("task-1").value).not.toBe("needs_questions");
    database.close();
  });

  it("plans a repeated internship section revealed by resume upload", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { nodeRef: fixtureNodeRef, id: "field-resume", label: "上传简历", type: "file", required: false, options: [], currentValue: "" }
      ]
    };
    const parsed: FormSnapshot = {
      ...form,
      id: "snapshot-parsed-with-internship-add",
      fields: [{ ...form.fields[0]!, currentValue: "resume.pdf" }],
      actions: [{ nodeRef: fixtureNodeRef, 
        id: "add-internship",
        text: "添加",
        class: "intermediate_navigation",
        context: "实习经历添加"
      }]
    };
    const expanded: FormSnapshot = {
      ...parsed,
      id: "snapshot-expanded-internship",
      fields: [
        parsed.fields[0]!,
        {nodeRef: fixtureNodeRef, 
          id: "internship-company",
          label: "实习单位",
          type: "text",
          required: true,
          options: [],
          currentValue: "",
          sectionHint: "internship"
        }
      ],
      actions: [{ nodeRef: fixtureNodeRef, id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const filled: FormSnapshot = {
      ...expanded,
      id: "snapshot-filled-internship",
      fields: expanded.fields.map((field) => field.id === "internship-company"
        ? { ...field, currentValue: "测试科技" }
        : field)
    };
    const execute = vi.fn(async (command: ExecutableCommand): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: "task-1",
      snapshotId: command.type === "upload" ? parsed.id : command.type === "click_intermediate" ? expanded.id : filled.id,
      commandType: command.type,
      status: "applied",
      actualValue: command.type === "upload" ? "resume.pdf" : command.type === "click_intermediate" ? expanded.url : "测试科技",
      snapshot: command.type === "upload" ? parsed : command.type === "click_intermediate" ? expanded : filled,
      errors: []
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: {
        observe: vi.fn()
          .mockResolvedValueOnce(expanded)
          .mockResolvedValue(filled),
        execute
      },
      resolveField: async () => ({ status: "verified", value: "测试科技" }),
      resolveFileId: () => "resume-file-1",
      listProfileFacts: () => [{
        id: "employment-type-0",
        fieldPath: "work[0].employmentType",
        value: "Java 后端实习",
        status: "user_confirmed",
        confidence: 1,
        scope: "profile",
        revision: 1,
        evidence: []
      }],
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1", form);

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      type: "click_intermediate",
      actionId: "add-internship"
    }), expect.any(Number));
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("waits on a job list until the user opens a resume form, then fills it automatically", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const jobList: FormSnapshot = {
      ...snapshot("application_form"),
      id: "snapshot-4399-jobs",
      url: "https://hr.4399om.com/weixin/?r=job/agent",
      title: "四三九九2027校园招聘",
      fields: [{ nodeRef: fixtureNodeRef, id: "field-keyword", label: "请输入关键词", type: "text", required: false, options: [], currentValue: "" }],
      actions: [{ nodeRef: fixtureNodeRef, id: "action-job", text: "Java开发工程师", class: "unknown_side_effect" }]
    };
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      id: "snapshot-4399-form",
      url: "https://hr.4399om.com/weixin/?r=job/apply&id=1",
      fields: [{ nodeRef: fixtureNodeRef, id: "field-name", label: "姓名", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ nodeRef: fixtureNodeRef, id: "action-submit", text: "提交", class: "terminal_submit" }]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-4399-filled",
      fields: [{ ...form.fields[0]!, currentValue: "张三" }]
    };
    const observe = vi.fn(async () => form);
    const execute = vi.fn(async (): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: "task-1",
      snapshotId: filled.id,
      commandType: "fill",
      status: "applied",
      actualValue: "张三",
      snapshot: filled,
      errors: []
    }));
    const resolveField = vi.fn(async () => ({ status: "verified" as const, value: "张三" }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField,
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: jobList.url });
    await service.runUntilPause("task-1", jobList);

    expect(service.state("task-1").value).toBe("observing");
    expect(service.progress("task-1").status).toBe("idle");
    expect(service.progress("task-1").executionProgress).toMatchObject({
      currentPhase: "waiting_for_form",
      current: { action: "等待进入简历填写页", maxAttempts: 2 }
    });
    expect(resolveField).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    await service.handleActivity({ type: "user_activity", taskId: "task-1", fieldId: "action-job", activity: "click" });
    expect(service.progress("task-1").status).toBe("idle");
    await service.handleActivity({ type: "page_unstable", taskId: "task-1", fingerprint: "4399-job-navigation" });
    expect(service.progress("task-1").status).toBe("idle");
    await service.handleActivity({ type: "page_stable", taskId: "task-1", fingerprint: "4399-application-form" });

    expect(observe).toHaveBeenCalledOnce();
    expect(resolveField).toHaveBeenCalledWith("task-1", expect.objectContaining({ id: "field-name" }), "deterministic");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: "fill", fieldId: "field-name" }), expect.any(Number));
    expect(service.state("task-1").value).toBe("review_locked");
    expect(service.progress("task-1").executionProgress?.currentPhase).toBe("final_review");
    database.close();
  });

  it("hands off for human review when preview and submit is the only remaining action", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      actions: [{ nodeRef: fixtureNodeRef, id: "action-preview-submit", text: "预览并提交", class: "terminal_submit" }]
    };
    const execute = vi.fn();
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: undefined }),
      approve: () => "unused"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("review_locked");
    expect(execute).not.toHaveBeenCalled();
    database.close();
  });

  it("does not lock review while required fields are still empty", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { nodeRef: fixtureNodeRef, id: "field-name", label: "姓名", type: "text", required: true, options: [], currentValue: "" }
      ],
      actions: [{ nodeRef: fixtureNodeRef, id: "action-preview-submit", text: "预览并提交", class: "terminal_submit" }]
    };
    const execute = vi.fn(async (): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: form.taskId,
      snapshotId: form.id,
      commandType: "fill",
      status: "applied",
      actualValue: "",
      snapshot: form,
      errors: []
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: undefined }),
      approve: () => "unused"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("needs_questions");
    expect(execute).not.toHaveBeenCalled();
    database.close();
  });

  it("leaves legal acknowledgements unchecked for final user review", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "field-certification",
        label: "I certify that the information is true and agree to the privacy policy",
        type: "checkbox",
        required: true,
        options: [],
        currentValue: false
      }],
      actions: [{ nodeRef: fixtureNodeRef, id: "action-submit", text: "Submit Application", class: "terminal_submit" }]
    };
    const execute = vi.fn();
    const resolveField = vi.fn(async () => ({ status: "verified" as const, value: true }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField,
      approve: () => "unused"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("review_locked");
    expect(resolveField).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    database.close();
  });

  it("stops when the browser reports success but leaves a required field empty", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }
      ],
      actions: [{ nodeRef: fixtureNodeRef, id: "action-preview-submit", text: "预览并提交", class: "terminal_submit" }]
    };
    const execute = vi.fn(async (): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: form.taskId,
      snapshotId: form.id,
      commandType: "fill",
      status: "applied",
      actualValue: "13800000000",
      snapshot: form,
      errors: []
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "13800000000" }),
      approve: () => "unused"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("failed");
    expect(service.state("task-1").context.errors).toContain("required_fields_empty:手机号码");
    expect(execute).toHaveBeenCalledOnce();
    database.close();
  });

  it("clicks a Mokahr section add action and then fills the newly observed entry", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form = {
      ...snapshot("application_form"),
      actions: [{ nodeRef: fixtureNodeRef, id: "add-project", text: "添加", class: "intermediate_navigation" as const, context: "项目经历" }]
    };
    const expanded = {
      ...form,
      id: "expanded",
      fields: [{ nodeRef: fixtureNodeRef, id: "project-name", label: "项目名称", type: "text" as const, required: false, options: [], currentValue: "" }],
      actions: [{ nodeRef: fixtureNodeRef, id: "preview", text: "预览并提交", class: "terminal_submit" as const }]
    };
    const execute = vi.fn().mockResolvedValue({
      type: "execution_result", taskId: "task-1", snapshotId: expanded.id,
      commandType: "click_intermediate", status: "applied", actualValue: expanded.url,
      snapshot: expanded, errors: []
    });
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "ApplyPilot" }),
      listProfileFacts: () => [{
        id: "project-0",
        fieldPath: "projects[0].name",
        value: "ApplyPilot",
        status: "user_confirmed",
        confidence: 1,
        scope: "profile",
        revision: 1,
        evidence: []
      }],
      approve: () => "approved"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: "click_intermediate", actionId: "add-project" }), expect.any(Number));
    database.close();
  });

  it("allows more than two successful additions for one repeated section", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const projectPage = (count: number): FormSnapshot => ({
      ...snapshot("application_form"),
      id: `projects-${count}`,
      fields: Array.from({ length: count }, (_, index) => ({ nodeRef: fixtureNodeRef, 
        id: `project-name-${index}`,
        label: "项目名称",
        type: "text" as const,
        required: false,
        options: [],
        currentValue: `Project ${index + 1}`,
        semanticHint: `projects[${index}].name`
      })),
      actions: [
        { nodeRef: fixtureNodeRef, id: "add-project", text: "添加", class: "intermediate_navigation", context: "项目经历" },
        { nodeRef: fixtureNodeRef, id: "preview", text: "预览并提交", class: "terminal_submit" }
      ]
    });
    const pages = [projectPage(2), projectPage(3), projectPage(4)];
    let pageIndex = 0;
    const execute = vi.fn(async (): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => {
      const nextPage = pages[pageIndex++]!;
      return {
        type: "execution_result",
        taskId: "task-1",
        snapshotId: nextPage.id,
        commandType: "click_intermediate",
        status: "applied",
        actualValue: nextPage.url,
        snapshot: nextPage,
        errors: []
      };
    });
    const observe = vi.fn(async () => pages[pageIndex - 1]!);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField: async () => ({ status: "verified", value: undefined }),
      listProfileFacts: () => Array.from({ length: 4 }, (_, index) => ({
        id: `project-${index}`,
        fieldPath: `projects[${index}].name`,
        value: `Project ${index + 1}`,
        status: "user_confirmed" as const,
        confidence: 1,
        scope: "profile" as const,
        revision: 1,
        evidence: []
      })),
      approve: () => "approved"
    });

    const initialPage = projectPage(1);
    service.start({ taskId: "task-1", applicationUrl: initialPage.url });
    await service.runUntilPause("task-1", initialPage);

    expect(execute).toHaveBeenCalledTimes(3);
    expect(observe).toHaveBeenCalledTimes(3);
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("does not treat an unneeded repeated-section add control as page navigation", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "formal-company",
        label: "公司名称",
        type: "text",
        required: false,
        options: [],
        currentValue: "",
        sectionHint: "work",
        semanticHint: "work[0].company"
      }],
      actions: [
        { nodeRef: fixtureNodeRef, id: "add-formal-work", text: "新增", class: "intermediate_navigation", context: "正式工作经历" },
        { nodeRef: fixtureNodeRef, id: "submit", text: "提交申请", class: "terminal_submit" }
      ]
    };
    const execute = vi.fn();
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "deferred" }),
      listProfileFacts: () => [{
        id: "internship-type",
        fieldPath: "work[0].employmentType",
        value: "实习",
        status: "user_confirmed",
        confidence: 1,
        scope: "profile",
        revision: 1,
        evidence: []
      }],
      approve: () => "approved"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(execute).not.toHaveBeenCalled();
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("treats page instability during repeated-section expansion as a controlled pause", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form = {
      ...snapshot("application_form"),
      actions: [{ nodeRef: fixtureNodeRef, id: "add-project", text: "添加", class: "intermediate_navigation" as const, context: "项目经历" }]
    };
    const execute = vi.fn(() => new Promise<never>(() => undefined));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "ApplyPilot" }),
      listProfileFacts: () => [0, 1].map((index) => ({
        id: `project-${index}`,
        fieldPath: `projects[${index}].name`,
        value: `项目 ${index + 1}`,
        status: "user_confirmed" as const,
        confidence: 1,
        scope: "profile" as const,
        revision: 1,
        evidence: []
      })),
      approve: () => "approved"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    const running = service.runUntilPause("task-1");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.handleActivity({ type: "page_unstable", taskId: "task-1", fingerprint: "expanding-project" });

    await expect(running).resolves.toBeUndefined();
    expect(service.progress("task-1")).toMatchObject({ status: "paused", busy: false });
    expect(service.state("task-1").value).not.toBe("cancelled");
    database.close();
  });

  it("re-observes a repeated section and does not click add again without a new entry", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form = {
      ...snapshot("application_form"),
      actions: [{ nodeRef: fixtureNodeRef, id: "add-project", text: "添加", class: "intermediate_navigation" as const, context: "项目经历" }]
    };
    const observe = vi.fn().mockResolvedValue(form);
    const execute = vi.fn().mockResolvedValue({
      type: "execution_result", taskId: "task-1", snapshotId: form.id,
      commandType: "click_intermediate", status: "applied", actualValue: form.url,
      snapshot: form, errors: []
    });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField: async () => ({ status: "verified", value: "ApplyPilot" }),
      listProfileFacts: () => [{
        id: "project-0",
        fieldPath: "projects[0].name",
        value: "ApplyPilot",
        status: "user_confirmed" as const,
        confidence: 1,
        scope: "profile" as const,
        revision: 1,
        evidence: []
      }],
      approve: () => "approved"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(service.progress("task-1")).toMatchObject({
      status: "paused",
      stalledFieldId: "add-project"
    });
    database.close();
  });

  it("does not automatically retry a repeated section after readback mismatch", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form = {
      ...snapshot("application_form"),
      actions: [{ nodeRef: fixtureNodeRef, id: "add-project", text: "添加", class: "intermediate_navigation" as const, context: "项目经历" }]
    };
    const observe = vi.fn().mockResolvedValue(form);
    const execute = vi.fn().mockResolvedValue({
      type: "execution_result", taskId: "task-1", snapshotId: form.id,
      commandType: "click_intermediate", status: "applied", actualValue: form.url,
      snapshot: form, errors: []
    });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField: async () => ({ status: "verified", value: "ApplyPilot" }),
      listProfileFacts: () => [{
        id: "project-0",
        fieldPath: "projects[0].name",
        value: "ApplyPilot",
        status: "user_confirmed" as const,
        confidence: 1,
        scope: "profile" as const,
        revision: 1,
        evidence: []
      }],
      approve: () => "approved"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    await service.handleActivity({ type: "page_stable", taskId: "task-1", fingerprint: "unchanged-projects" });

    expect(execute).toHaveBeenCalledOnce();
    expect(service.progress("task-1")).toMatchObject({
      status: "paused",
      stalledFieldId: "add-project",
      recovery: ["retry_current", "cancel"]
    });
    database.close();
  });

  it("continues filling after a repeated entry appears in the post-click observation", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form = {
      ...snapshot("application_form"),
      actions: [{ nodeRef: fixtureNodeRef, id: "add-project", text: "添加", class: "intermediate_navigation" as const, context: "项目经历" }]
    };
    const expanded: FormSnapshot = {
      ...form,
      id: "expanded-project",
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "project-name",
        label: "项目名称",
        type: "text",
        required: false,
        options: [],
        currentValue: ""
      }],
      actions: [{ nodeRef: fixtureNodeRef, id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const filled: FormSnapshot = {
      ...expanded,
      fields: [{ ...expanded.fields[0]!, currentValue: "ApplyPilot" }]
    };
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockResolvedValueOnce(expanded)
      .mockResolvedValue(filled);
    const execute = vi.fn()
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: form.id,
        commandType: "click_intermediate", status: "applied", actualValue: form.url,
        snapshot: form, errors: []
      })
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: filled.id,
        commandType: "fill", status: "applied", actualValue: "ApplyPilot",
        snapshot: filled, errors: []
      });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField: async () => ({ status: "verified", value: "ApplyPilot" }),
      listProfileFacts: () => [{
        id: "project-0",
        fieldPath: "projects[0].name",
        value: "ApplyPilot",
        status: "user_confirmed" as const,
        confidence: 1,
        scope: "profile" as const,
        revision: 1,
        evidence: []
      }],
      approve: () => "approved"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(observe).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      expect.objectContaining({ type: "click_intermediate", actionId: "add-project" }),
      expect.objectContaining({ type: "fill", fieldId: "project-name", value: "ApplyPilot" })
    ]);
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("derives project entry semantics before resolving and filling repeated form fields", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { nodeRef: fixtureNodeRef, id: "project-name", label: "项目名称", type: "text", required: true, options: [], currentValue: "" },
        { nodeRef: fixtureNodeRef, id: "project-description", label: "项目描述", type: "textarea", required: true, options: [], currentValue: "" }
      ],
      actions: [{ nodeRef: fixtureNodeRef, id: "preview", text: "预览并提交", class: "terminal_submit" }]
    };
    const execute = vi.fn(async (command: ExecutableCommand): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => ({
      type: "execution_result",
      taskId: command.taskId,
      snapshotId: form.id,
      commandType: command.type,
      status: "applied",
      actualValue: command.type === "fill" ? command.value : form.url,
      snapshot: form,
      errors: []
    }));
    const resolveField = vi.fn(async (_taskId: string, field: FormField) => ({
      status: "verified" as const,
      value: field.semanticHint === "projects[0].name" ? "星迹社区" : "高并发内容社交平台"
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField,
      approve: () => "approved"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(resolveField.mock.calls.map(([, field]) => field.semanticHint)).toEqual([
      "projects[0].name",
      "projects[0].description"
    ]);
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      expect.objectContaining({ type: "fill", fieldId: "project-name", value: "星迹社区" }),
      expect.objectContaining({ type: "fill", fieldId: "project-description", value: "高并发内容社交平台" })
    ]);
    expect(service.state("task-1").value).toBe("failed");
    expect(service.state("task-1").context.errors).toContain("required_fields_empty:项目名称");
    database.close();
  });

  it("continues through successive intermediate pages until the review snapshot", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const firstPage = snapshot("application_form", { action: true });
    const secondPage: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      id: "snapshot-second-page",
      url: "https://jobs.example.test/application/step-2"
    };
    const review = snapshot("review");
    const execute = vi.fn()
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: secondPage.id,
        commandType: "click_intermediate", status: "applied", actualValue: secondPage.url,
        snapshot: secondPage, errors: []
      })
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: review.id,
        commandType: "click_intermediate", status: "applied", actualValue: review.url,
        snapshot: review, errors: []
      });
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => firstPage, execute },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: firstPage.url });
    await service.runUntilPause("task-1");

    expect(service.state("task-1").value).toBe("review_locked");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(([command]) => command.type)).toEqual([
      "click_intermediate",
      "click_intermediate"
    ]);
    expect(checkpoints.latest("task-1")?.state).toBe("review_locked");
    database.close();
  });

  it("同页中间点击即使被误报为成功也会安全停止且不递归重跑", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form = snapshot("application_form", { action: true });
    const execute = vi.fn()
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: form.id,
        commandType: "click_intermediate", status: "applied", actualValue: form.url,
        snapshot: form, errors: []
      })
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: form.id,
        commandType: "click_intermediate", status: "failed", actualValue: form.url,
        snapshot: form, errors: ["intermediate_no_progress"]
      });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledOnce();
    expect(service.state("task-1")).toMatchObject({
      value: "failed",
      context: { errors: ["intermediate_no_progress"] }
    });
    database.close();
  });

  it("keeps a safety-blocked intermediate action terminal and non-retryable", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form = snapshot("application_form", { action: true });
    const execute = vi.fn().mockResolvedValue({
      type: "execution_result" as const,
      taskId: "task-1",
      snapshotId: form.id,
      commandType: "click_intermediate" as const,
      status: "blocked" as const,
      actualValue: null,
      snapshot: form,
      errors: ["unsafe_intermediate_action"]
    });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "approved-token"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");

    expect(service.state("task-1")).toMatchObject({
      value: "failed",
      context: { errors: ["unsafe_intermediate_action"] }
    });
    expect(service.recoveryCommands("task-1")).toEqual([]);
    database.close();
  });

  it("aggregates all field questions into one pause and resumes only after answers", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { nodeRef: fixtureNodeRef, id: "field-email", label: "邮箱", type: "text", required: true, options: [], currentValue: "" },
        { nodeRef: fixtureNodeRef, id: "field-city", label: "城市", type: "text", required: true, options: [], currentValue: "" }
      ]
    };
    const applyAnswers = vi.fn();
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async (_taskId, field) => ({
        status: "needs_question",
        question: `请补充${field.label}`
      }),
      approve: () => "unused",
      applyAnswers
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("needs_questions");
    expect(service.state("task-1").context.questions).toEqual([
      { id: "field-email", fieldId: "field-email", fieldPath: "field-email", label: "邮箱", text: "请补充邮箱", pageText: "邮箱", interpretation: "系统已识别该字段，但尚无可安全填写的已确认资料", missingInformation: "请补充邮箱", scope: "application", inputType: "text", options: [], required: true },
      { id: "field-city", fieldId: "field-city", fieldPath: "field-city", label: "城市", text: "请补充城市", pageText: "城市", interpretation: "系统已识别该字段，但尚无可安全填写的已确认资料", missingInformation: "请补充城市", scope: "application", inputType: "text", options: [], required: true }
    ]);
    expect(checkpoints.latest("task-1")?.questions).toEqual([
      { id: "field-email", fieldId: "field-email", fieldPath: "field-email", label: "邮箱", text: "请补充邮箱", pageText: "邮箱", interpretation: "系统已识别该字段，但尚无可安全填写的已确认资料", missingInformation: "请补充邮箱", scope: "application", inputType: "text", options: [], required: true },
      { id: "field-city", fieldId: "field-city", fieldPath: "field-city", label: "城市", text: "请补充城市", pageText: "城市", interpretation: "系统已识别该字段，但尚无可安全填写的已确认资料", missingInformation: "请补充城市", scope: "application", inputType: "text", options: [], required: true }
    ]);

    await service.answerQuestions("task-1", {
      "field-email": "me@example.com",
      "field-city": "杭州"
    });
    expect(applyAnswers).toHaveBeenCalledOnce();
    expect(service.state("task-1").value).toBe("observing");
    database.close();
  });

  it("rejects partial and unknown question answer sets", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { nodeRef: fixtureNodeRef, id: "field-email", label: "邮箱", type: "text", required: true, options: [], currentValue: "" },
        { nodeRef: fixtureNodeRef, id: "field-city", label: "城市", type: "text", required: true, options: [], currentValue: "" }
      ]
    };
    const applyAnswers = vi.fn();
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async (_taskId, field) => ({ status: "needs_question", question: `请补充${field.label}` }),
      approve: () => "unused",
      applyAnswers
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    await expect(service.answerQuestions("task-1", { "field-email": "me@example.com" }))
      .rejects.toThrow("incomplete_question_answers");
    await expect(service.answerQuestions("task-1", { "field-email": "me@example.com", unknown: "杭州" }))
      .rejects.toThrow("incomplete_question_answers");
    expect(applyAnswers).not.toHaveBeenCalled();
    expect(service.state("task-1").value).toBe("needs_questions");
    database.close();
  });

  it("fails closed when question answers cannot be persisted", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-city", label: "城市", type: "text", required: true, options: [], currentValue: "" }]
    };
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "needs_question", question: "请选择城市" }),
      approve: () => "unused",
      applyAnswers: async () => { throw new Error("database unavailable"); }
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    await expect(service.answerQuestions("task-1", { "field-city": "杭州" }))
      .rejects.toThrow("answer_persistence_failed");
    expect(service.state("task-1").value).toBe("needs_questions");
    database.close();
  });

  it("refuses to leave question state without an answer persistence adapter", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-city", label: "城市", type: "text", required: true, options: [], currentValue: "" }]
    };
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "needs_question" }),
      approve: () => "unused"
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    await expect(service.answerQuestions("task-1", { "field-city": "杭州" }))
      .rejects.toThrow("answer_persistence_unavailable");
    expect(service.state("task-1").value).toBe("needs_questions");
    database.close();
  });

  it("re-observes a checkpoint on restart and rejects blind replay after page drift", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-email", label: "邮箱", type: "text", required: true, options: [], currentValue: "" }]
    };
    checkpoints.save({
      taskId: "task-1",
      state: "observing",
      url: form.url,
      stage: form.stage,
      snapshotId: form.id,
      fieldIds: form.fields.map((field) => field.id),
      questions: []
    });
    const matchingService = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    await matchingService.resume("task-1");
    expect(matchingService.state("task-1").value).toBe("observing");

    const changed = { ...form, id: "snapshot-changed", fields: [] };
    const changedService = createApplicationService({
      checkpoints,
      browser: { observe: async () => changed, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    await expect(changedService.resume("task-1")).rejects.toThrow("checkpoint_mismatch");
    database.close();
  });

  it("recovers a transient checkpoint by observing before any navigation or mutation", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form = snapshot("application_form", { action: true });
    checkpoints.save({
      taskId: "task-1",
      state: "filling",
      url: form.url,
      stage: form.stage,
      snapshotId: form.id,
      fieldIds: [],
      questions: [],
      snapshot: form
    });
    const open = vi.fn();
    const observe = vi.fn(async () => form);
    const execute = vi.fn();
    const service = createApplicationService({
      checkpoints,
      browser: { open, observe, execute },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });

    expect(service.state("task-1").value).toBe("observing");
    expect(service.requiresRecovery("task-1")).toBe(true);
    await expect(service.openBrowser("task-1")).rejects.toThrow("checkpoint_recovery_requires_resume");
    await service.resume("task-1");

    expect(open).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(service.requiresRecovery("task-1")).toBe(false);
    database.close();
  });

  it("reopens the checkpoint page when retrying after the browser worker restarts on a blank page", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "field-email",
        label: "邮箱",
        type: "text",
        required: true,
        options: [],
        currentValue: ""
      }]
    };
    checkpoints.save({
      taskId: "task-1",
      state: "observing",
      url: form.url,
      stage: form.stage,
      snapshotId: form.id,
      fieldIds: form.fields.map((field) => field.id),
      questions: [],
      snapshot: form
    });
    checkpoints.saveProgress("task-1", {
      status: "paused",
      busy: false,
      generation: 1,
      retryCount: 0,
      stalledFieldId: "field-email",
      recovery: ["retry_current", "manual_done", "cancel"]
    });
    const blank: FormSnapshot = {
      ...snapshot("unknown"),
      id: "snapshot-blank",
      url: "about:blank"
    };
    const open = vi.fn(async () => undefined);
    const observe = vi.fn()
      .mockResolvedValueOnce(blank)
      .mockResolvedValueOnce(form);
    const service = createApplicationService({
      checkpoints,
      browser: { open, observe, execute: vi.fn() },
      resolveField: async () => ({ status: "needs_question", question: "请确认邮箱" }),
      approve: () => "unused"
    });

    expect(service.recoveryCommands("task-1")).toContain("retry_current");
    await service.retryCurrent("task-1");

    expect(open).toHaveBeenCalledWith("task-1", form.url);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(service.state("task-1").value).toBe("needs_questions");
    database.close();
  });

  it("clears a restored recovery checkpoint when the task is cancelled", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form = snapshot("application_form", { action: true });
    checkpoints.save({
      taskId: "task-1",
      state: "filling",
      url: form.url,
      stage: form.stage,
      snapshotId: form.id,
      fieldIds: [],
      questions: [],
      snapshot: form
    });
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });

    expect(service.state("task-1").value).toBe("observing");
    expect(service.requiresRecovery("task-1")).toBe(true);

    await service.cancel("task-1");

    expect(service.state("task-1").value).toBe("cancelled");
    expect(service.requiresRecovery("task-1")).toBe(false);
    expect(service.recoveryCommands("task-1")).toEqual([]);
    database.close();
  });

  it("finishes cancellation and releases the local reservation when browser cleanup fails", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form = snapshot("application_form", { action: true });
    const releaseTask = vi.fn(async () => {
      throw new Error("worker_disconnected");
    });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { open: vi.fn(), observe: async () => form, execute: vi.fn(), releaseTask },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    service.start({ taskId: "task-2", applicationUrl: form.url });
    await service.openBrowser("task-1");

    await expect(service.cancel("task-1")).resolves.toBeUndefined();

    expect(releaseTask).toHaveBeenCalledWith("task-1");
    expect(service.state("task-1").value).toBe("cancelled");
    expect(service.recoveryCommands("task-1")).toEqual([]);
    await expect(service.openBrowser("task-2")).resolves.toBeUndefined();
    database.close();
  });

  it("reserves the controlled browser before an asynchronous open completes", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    let releaseFirstOpen: (() => void) | undefined;
    const firstOpen = new Promise<void>((resolve) => { releaseFirstOpen = resolve; });
    const open = vi.fn((taskId: string) => taskId === "task-1" ? firstOpen : Promise.resolve());
    const service = createApplicationService({
      checkpoints,
      browser: { open, observe: async () => snapshot("application_form"), execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId: "task-1", applicationUrl: "https://jobs.example.test/one" });
    service.start({ taskId: "task-2", applicationUrl: "https://jobs.example.test/two" });

    const opening = service.openBrowser("task-1");
    try {
      await expect(service.openBrowser("task-2")).rejects.toThrow("browser_task_in_use");
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirstOpen?.();
      await opening;
    }
    database.close();
  });

  it("preserves browser_task_in_use when a job match session owns the shared browser lease", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const browserOwnershipLease = new BrowserOwnershipLease();
    browserOwnershipLease.acquire({ ownerKind: "job_match", ownerId: "jm-1" });
    const open = vi.fn(async () => undefined);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browserOwnershipLease,
      browser: { open, observe: async () => snapshot("application_form"), execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId: "task-1", applicationUrl: "https://jobs.example.test/apply" });

    await expect(service.openBrowser("task-1")).rejects.toThrow("browser_task_in_use");
    expect(open).not.toHaveBeenCalled();
    database.close();
  });

  it("reserves the controlled browser before resuming an existing login task", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const observe = vi.fn(async () => snapshot("application_form"));
    const service = createApplicationService({
      checkpoints,
      browser: { open: vi.fn(async () => undefined), observe, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId: "task-1", applicationUrl: "https://jobs.example.test/one" });
    service.start({ taskId: "task-2", applicationUrl: "https://jobs.example.test/two" });
    await service.runUntilPause("task-1", snapshot("login"));
    await service.openBrowser("task-2");

    await expect(service.resume("task-1")).rejects.toThrow("browser_task_in_use");
    expect(observe).not.toHaveBeenCalled();

    await service.cancel("task-2");
    await service.resume("task-1");
    expect(service.activeBrowserTaskId()).toBe("task-1");
    expect(observe).toHaveBeenCalledOnce();
    database.close();
  });

  it("disposes terminal task state after its persisted task is removed", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => snapshot("application_form"), execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId: "task-1", applicationUrl: "https://jobs.example.test/apply" });

    service.dispose("task-1");

    expect(() => service.state("task-1")).toThrow("application_task_not_found");
    expect(service.activeBrowserTaskId()).toBeUndefined();
    database.close();
  });

  it("publishes every persisted browser workflow state in order", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";
    createApplicationTaskRepository(database).create({ id: taskId, applicationUrl: "https://jobs.example.test/apply" });
    const taskEvents = createTaskEventBus(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      taskId,
      fields: [{ nodeRef: fixtureNodeRef, id: "field-email", label: "邮箱", type: "text", required: true, options: [], currentValue: "" }]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-filled",
      fields: [{ ...form.fields[0]!, currentValue: "me@example.com" }]
    };
    const review: FormSnapshot = { ...snapshot("review"), taskId };
    const execute = vi.fn()
      .mockResolvedValueOnce({
        type: "execution_result", taskId, snapshotId: filled.id, commandType: "fill",
        status: "applied", actualValue: "me@example.com", snapshot: filled, errors: []
      })
      .mockResolvedValueOnce({
        type: "execution_result", taskId, snapshotId: review.id, commandType: "click_intermediate",
        status: "applied", actualValue: review.url, snapshot: review, errors: []
      });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      taskEvents,
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "me@example.com" }),
      approve: () => "approved"
    });

    service.start({ taskId, applicationUrl: form.url });
    await service.runUntilPause(taskId);

    expect(taskEvents.history(taskId).map((event) => event.state)).toEqual([
      "observing_page", "filling", "validating", "navigating", "review_locked"
    ]);
    database.close();
  });

  it("pauses for manual login and re-observes after the user resumes", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const login = snapshot("login");
    const form = snapshot("application_form", { action: true });
    const observe = vi.fn()
      .mockResolvedValueOnce(login)
      .mockResolvedValueOnce(form);
    const service = createApplicationService({
      checkpoints,
      browser: { observe, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });

    service.start({ taskId: "task-1", applicationUrl: login.url });
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("awaiting_login");

    await service.resume("task-1");
    expect(service.state("task-1").value).toBe("observing");
    expect(checkpoints.latest("task-1")).toMatchObject({
      state: "observing",
      snapshotId: form.id
    });
    database.close();
  });

  it("pauses for content review before filling a tailored self-evaluation", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "field-self-evaluation",
        label: "自我评价",
        type: "textarea",
        required: true,
        options: [],
        currentValue: ""
      }]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-filled",
      fields: [{ ...form.fields[0]!, currentValue: "面向岗位微调后的自我评价" }]
    };
    const review = snapshot("review");
    const execute = vi.fn(async (command: { type: string }): Promise<Extract<WorkerResponse, { type: "execution_result" }>> => {
      const nextSnapshot = command.type === "fill" ? filled : review;
      return {
        type: "execution_result",
        taskId: "task-1",
        snapshotId: nextSnapshot.id,
        commandType: command.type === "fill" ? "fill" : "click_intermediate",
        status: "applied",
        actualValue: command.type === "fill" ? "面向岗位微调后的自我评价" : review.url,
        snapshot: nextSnapshot,
        errors: []
      };
    });
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute },
      resolveField: async () => ({
        status: "verified",
        value: "面向岗位微调后的自我评价",
        requiresContentReview: true
      }),
      approve: () => "approved",
      applyAnswers: vi.fn(),
      validateContentReview: () => []
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("awaiting_content_review");
    expect(execute).not.toHaveBeenCalled();

    await service.approveReview("task-1", service.contentReview("task-1")!.id);
    expect(service.state("task-1").value).toBe("filling");
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("validates content review ids and persists the edited value before filling", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "field-self-evaluation",
        label: "自我评价",
        type: "textarea",
        required: true,
        options: [],
        currentValue: ""
      }]
    };
    const applyAnswers = vi.fn();
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({
        status: "verified",
        value: "面向岗位微调后的自我评价",
        requiresContentReview: true
      }),
      approve: () => "unused",
      applyAnswers,
      validateContentReview: () => []
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    const review = service.contentReview("task-1");
    expect(review).toMatchObject({ draft: "面向岗位微调后的自我评价" });

    await expect(service.approveReview("task-1", "wrong-review-id", "用户修订后的自我评价"))
      .rejects.toThrow("content_review_mismatch");
    expect(service.state("task-1").value).toBe("awaiting_content_review");

    await service.approveReview("task-1", review!.id, "用户修订后的自我评价");
    expect(applyAnswers).toHaveBeenCalledWith(
      "task-1",
      { "field-self-evaluation": "用户修订后的自我评价" },
      [expect.objectContaining({ id: "field-self-evaluation" })]
    );
    expect(service.state("task-1").value).toBe("filling");
    database.close();
  });

  it("rejects an edited review that introduces unsupported claims", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "self", label: "自我评价", type: "textarea", required: true, options: [], currentValue: "" }]
    };
    const applyAnswers = vi.fn();
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({
        status: "verified",
        value: "具备 Java 项目经验",
        requiresContentReview: true,
        contentReview: { original: "具备 Java 项目经验", reasons: ["岗位匹配"], evidence: [], unsupportedClaims: [], status: "needs_review" }
      }),
      approve: () => "unused",
      applyAnswers,
      validateContentReview: (_review, value) => value.includes("Rust") ? ["Rust"] : []
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    const review = service.contentReview("task-1")!;
    await expect(service.approveReview("task-1", review.id, "具备 Rust 项目经验"))
      .rejects.toThrow("content_review_unsupported_edit");
    expect(applyAnswers).not.toHaveBeenCalled();
    expect(service.state("task-1").value).toBe("awaiting_content_review");
    database.close();
  });

  it("refuses content approval when fact validation is unavailable", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "self", label: "自我评价", type: "textarea", required: true, options: [], currentValue: "" }]
    };
    const applyAnswers = vi.fn();
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "原始内容", requiresContentReview: true }),
      approve: () => "unused",
      applyAnswers
    });

    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    const review = service.contentReview("task-1")!;
    await expect(service.approveReview("task-1", review.id, "编辑内容"))
      .rejects.toThrow("content_review_validation_unavailable");
    expect(applyAnswers).not.toHaveBeenCalled();
    database.close();
  });

  it("scopes content review ids to their task", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const formFor = (taskId: string): FormSnapshot => ({
      ...snapshot("application_form", { action: true }),
      id: `snapshot-${taskId}`,
      taskId,
      fields: [{ nodeRef: fixtureNodeRef, id: "self", label: "自我评价", type: "textarea", required: true, options: [], currentValue: "" }]
    });
    let current = formFor("task-a");
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => current, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "草稿", requiresContentReview: true }),
      approve: () => "unused",
      applyAnswers: vi.fn()
    });
    service.start({ taskId: "task-a", applicationUrl: current.url });
    await service.runUntilPause("task-a");
    const reviewA = service.contentReview("task-a")!;

    current = formFor("task-b");
    service.start({ taskId: "task-b", applicationUrl: current.url });
    await service.runUntilPause("task-b");
    await expect(service.rejectReview("task-b", reviewA.id)).rejects.toThrow("content_review_mismatch");
    expect(service.state("task-b").value).toBe("awaiting_content_review");
    database.close();
  });

  it("restores a pending content review after a process restart", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "self", label: "自我评价", type: "textarea", required: true, options: [], currentValue: "" }]
    };
    const first = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "待审核草稿", requiresContentReview: true }),
      approve: () => "unused",
      applyAnswers: vi.fn(),
      validateContentReview: () => []
    });
    first.start({ taskId: "task-1", applicationUrl: form.url });
    await first.runUntilPause("task-1");
    const review = first.contentReview("task-1")!;

    const applyAnswers = vi.fn();
    const restarted = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "待审核草稿" }),
      approve: () => "unused",
      applyAnswers,
      validateContentReview: () => []
    });

    expect(restarted.state("task-1").value).toBe("awaiting_content_review");
    expect(restarted.contentReview("task-1")).toEqual(review);
    await restarted.approveReview("task-1", review.id, "重启后修订值");
    expect(applyAnswers).toHaveBeenCalledWith("task-1", { self: "重启后修订值" }, form.fields);
    database.close();
  });

  it.each(["filling", "validating", "navigating"] as const)(
    "restores transient %s checkpoints only as observing",
    (state) => {
      const database = new Database(":memory:");
      migrateDatabase(database);
      const checkpoints = createCheckpointRepository(database);
      const form = snapshot("application_form", { action: true });
      checkpoints.save({
        taskId: "task-1",
        state,
        url: form.url,
        stage: form.stage,
        snapshotId: form.id,
        fieldIds: [],
        questions: [],
        snapshot: form
      });
      const restarted = createApplicationService({
        checkpoints,
        browser: { observe: async () => form, execute: vi.fn() },
        resolveField: async () => ({ status: "verified", value: "" }),
        approve: () => "unused",
        applyAnswers: vi.fn()
      });

      expect(restarted.state("task-1").value).toBe("observing");
      database.close();
    }
  );

  it("restores cancelled checkpoints as cancelled", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form = snapshot("application_form");
    checkpoints.save({
      taskId: "task-1",
      state: "cancelled",
      url: form.url,
      stage: form.stage,
      snapshotId: form.id,
      fieldIds: [],
      questions: [],
      snapshot: form
    });
    const restarted = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused",
      applyAnswers: vi.fn()
    });

    expect(restarted.state("task-1").value).toBe("cancelled");
    database.close();
  });

  it("显式取消会终止当前自动操作且旧结果不能继续后续自动化", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }]
    };
    let finishFill!: (result: WorkerResponse & { type: "execution_result" }) => void;
    const execute = vi.fn().mockImplementationOnce(() => new Promise<WorkerResponse & { type: "execution_result" }>((resolve) => {
      finishFill = resolve;
    }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "自动值" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    const running = service.runUntilPause("task-1");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.cancel("task-1");

    expect(service.state("task-1").value).toBe("cancelled");
    expect(service.progress("task-1").busy).toBe(false);
    finishFill({
      type: "execution_result", taskId: "task-1", snapshotId: form.id,
      commandType: "fill", status: "applied", actualValue: "自动值",
      snapshot: form, errors: []
    });
    await running;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.state("task-1").value).toBe("cancelled");
    database.close();
  });

  it("解析字段期间的用户活动会暂停并使排队运行失效", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }]
    };
    let finishResolution!: (decision: { status: "verified"; value: string }) => void;
    const resolveField = vi.fn(() => new Promise<{ status: "verified"; value: string }>((resolve) => {
      finishResolution = resolve;
    }));
    const execute = vi.fn();
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField,
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    const running = service.runUntilPause("task-1", form);
    await vi.waitFor(() => expect(resolveField).toHaveBeenCalledOnce());

    await service.handleActivity({
      type: "user_activity", taskId: "task-1", fieldId: "field-phone", activity: "input"
    });

    expect(service.progress("task-1")).toMatchObject({ status: "paused", busy: false });
    finishResolution({ status: "verified", value: "自动值" });
    await running;
    expect(execute).not.toHaveBeenCalled();
    expect(service.state("task-1").value).toBe("observing");
    database.close();
  });

  it("用户活动会取消当前自动填写，页面稳定回读后安全续跑", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }]
    };
    const manuallyFilled: FormSnapshot = {
      ...form,
      id: "snapshot-manual",
      fields: [{ ...form.fields[0]!, currentValue: "已由用户填写" }]
    };
    const review = snapshot("review");
    const execute = vi.fn()
      .mockImplementationOnce(() => new Promise<never>(() => undefined))
      .mockResolvedValueOnce({
        type: "execution_result", taskId: "task-1", snapshotId: review.id,
        commandType: "click_intermediate", status: "applied", actualValue: review.url,
        snapshot: review, errors: []
      });
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockResolvedValue(manuallyFilled);
    const service = createApplicationService({
      checkpoints,
      browser: { observe, execute },
      resolveField: async () => ({ status: "verified", value: "自动值" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    const running = service.runUntilPause("task-1");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.handleActivity({
      type: "user_activity", taskId: "task-1", fieldId: "field-phone", activity: "input"
    });
    await running;

    expect(service.progress("task-1")).toMatchObject({ status: "paused", busy: false });
    await service.handleActivity({ type: "page_stable", taskId: "task-1", fingerprint: "structure-1" });

    await vi.waitFor(() => expect(service.state("task-1").value).toBe("review_locked"));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({ type: "click_intermediate" });
    database.close();
  });

  it("用户手动跳到同站新表单后由稳定事件重新观察并安全续跑", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const firstPage: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      id: "snapshot-contact",
      url: "https://jobs.example.test/apply/contact",
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "field-phone",
        label: "手机号码",
        type: "text",
        required: true,
        options: [],
        currentValue: ""
      }]
    };
    const secondPage: FormSnapshot = {
      ...snapshot("application_form"),
      id: "snapshot-profile",
      url: "https://jobs.example.test/apply/profile",
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "field-email",
        label: "邮箱",
        type: "text",
        required: true,
        options: [],
        currentValue: ""
      }],
      actions: [{ nodeRef: fixtureNodeRef, id: "action-submit", text: "提交申请", class: "terminal_submit" }]
    };
    const filledSecondPage: FormSnapshot = {
      ...secondPage,
      id: "snapshot-profile-filled",
      fields: [{ ...secondPage.fields[0]!, currentValue: "agent@example.com" }]
    };
    const execute = vi.fn(async (command: ExecutableCommand) => {
      if (command.type === "fill" && command.fieldId === "field-phone") {
        return new Promise<never>(() => undefined);
      }
      if (command.type !== "fill" || command.fieldId !== "field-email") {
        throw new Error(`不应执行命令：${command.type}`);
      }
      return {
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: filledSecondPage.id,
        commandType: "fill" as const,
        status: "applied" as const,
        actualValue: "agent@example.com",
        snapshot: filledSecondPage,
        errors: []
      };
    });
    const observe = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValue(secondPage);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField: async (_taskId, field) => ({
        status: "verified",
        value: field.id === "field-email" ? "agent@example.com" : "13800138000"
      }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: firstPage.url });
    const running = service.runUntilPause("task-1");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.handleActivity({
      type: "user_activity", taskId: "task-1", fieldId: "action-next", activity: "click"
    });
    await running;
    await service.handleActivity({
      type: "page_stable", taskId: "task-1", fingerprint: "profile-page"
    });

    expect(observe).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toMatchObject({ type: "fill", fieldId: "field-email" });
    expect(execute.mock.calls.flatMap(([command]) =>
      "actionId" in command ? [command.actionId] : [])).not.toContain("action-submit");
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("用户手动跳到同源非申请页面后保持暂停且不自动填写", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const firstPage: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      id: "snapshot-contact",
      url: "https://jobs.example.test/apply/contact",
      fields: [{ nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }]
    };
    const jobsPage: FormSnapshot = {
      ...snapshot("application_form"),
      id: "snapshot-jobs",
      url: "https://jobs.example.test/jobs",
      fields: [{ nodeRef: fixtureNodeRef, id: "field-keyword", label: "搜索岗位", type: "text", required: false, options: [], currentValue: "" }]
    };
    const execute = vi.fn()
      .mockImplementationOnce(() => new Promise<never>(() => undefined))
      .mockResolvedValueOnce({
        type: "execution_result",
        taskId: "task-1",
        snapshotId: jobsPage.id,
        commandType: "fill",
        status: "failed",
        actualValue: "",
        snapshot: jobsPage,
        errors: ["readback_mismatch"]
      });
    const observe = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValue(jobsPage);
    const resolveField = vi.fn(async () => ({ status: "verified" as const, value: "不应填写" }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute },
      resolveField,
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: firstPage.url });
    const running = service.runUntilPause("task-1");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.handleActivity({ type: "user_activity", taskId: "task-1", fieldId: "action-back", activity: "click" });
    await running;
    resolveField.mockClear();
    execute.mockClear();
    await service.handleActivity({ type: "page_stable", taskId: "task-1", fingerprint: "jobs-page" });

    expect(service.progress("task-1").status).toBe("paused");
    expect(resolveField).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    database.close();
  });

  it("Mokahr 从申请表 hash 跳回岗位列表后保持暂停", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const applicationPage: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      id: "snapshot-mokahr-application",
      url: "https://app.mokahr.com/m/campus-recruitment/dji/143359#/application/contact",
      fields: [{ nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }]
    };
    const jobsPage: FormSnapshot = {
      ...snapshot("application_form"),
      id: "snapshot-mokahr-jobs",
      url: "https://app.mokahr.com/m/campus-recruitment/dji/143359#/jobs",
      fields: [{ nodeRef: fixtureNodeRef, id: "field-keyword", label: "搜索岗位", type: "text", required: false, options: [], currentValue: "" }]
    };
    const execute = vi.fn()
      .mockImplementationOnce(() => new Promise<never>(() => undefined))
      .mockResolvedValueOnce({ type: "execution_result", taskId: "task-1", snapshotId: jobsPage.id, commandType: "fill", status: "failed", actualValue: "", snapshot: jobsPage, errors: ["readback_mismatch"] });
    const resolveField = vi.fn(async () => ({ status: "verified" as const, value: "不应填写" }));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: vi.fn().mockResolvedValueOnce(applicationPage).mockResolvedValue(jobsPage), execute },
      resolveField,
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: applicationPage.url });
    const running = service.runUntilPause("task-1");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.handleActivity({ type: "user_activity", taskId: "task-1", fieldId: "action-back", activity: "click" });
    await running;
    resolveField.mockClear();
    execute.mockClear();
    await service.handleActivity({ type: "page_stable", taskId: "task-1", fingerprint: "mokahr-jobs" });

    expect(service.progress("task-1").status).toBe("paused");
    expect(resolveField).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    database.close();
  });

  it("离开登录页后由稳定事件自动恢复既有流程", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const login = snapshot("login");
    const review = snapshot("review");
    const observe = vi.fn()
      .mockResolvedValueOnce(login)
      .mockResolvedValue(review);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute: vi.fn() },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId: "task-1", applicationUrl: login.url });
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("awaiting_login");

    await service.handleActivity({
      type: "user_activity", taskId: "task-1", fieldId: "field-password", activity: "input"
    });
    expect(service.progress("task-1").status).toBe("paused");

    await service.handleActivity({ type: "page_stable", taskId: "task-1", fingerprint: "review-structure" });

    expect(service.state("task-1").value).toBe("review_locked");
    expect(observe).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("普通控件点击会立即暂停当前自动操作", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form", { action: true }),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-email", label: "邮箱", type: "text", required: true, options: [], currentValue: "" }]
    };
    const execute = vi.fn(() => new Promise<never>(() => undefined));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: async () => form, execute },
      resolveField: async () => ({ status: "verified", value: "agent@example.com" }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    const running = service.runUntilPause("task-1", form);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.handleActivity({
      type: "user_activity", taskId: "task-1", fieldId: "action_opaque", activity: "click"
    });

    await running;
    expect(service.progress("task-1")).toMatchObject({
      status: "paused", busy: false, stalledFieldId: "field-email",
      recovery: ["retry_current", "manual_done", "cancel"]
    });
    database.close();
  });

  it("生产活动订阅将观察失败投影为可见的 PAGE_ERROR 暂停事件", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";
    const taskEvents = createTaskEventBus(database);
    let activityListener: ((activity: WorkerActivity) => void) | undefined;
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      taskEvents,
      browser: {
        observe: vi.fn(async () => { throw new Error("browser observation failed"); }),
        execute: vi.fn(),
        onActivity(listener) {
          activityListener = listener;
          return () => undefined;
        }
      },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });

    activityListener?.({ type: "page_stable", taskId, fingerprint: "page_fingerprint" });

    await vi.waitFor(() => expect(service.progress(taskId)).toMatchObject({
      status: "paused",
      busy: false,
      stalledFieldId: "page",
      recovery: ["retry_current", "cancel"],
      lastResult: { operation: { status: "failed", errorCode: "PAGE_ERROR" } }
    }));
    expect(taskEvents.replayAll(taskId).events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "operation_failed",
        operation: expect.objectContaining({ status: "failed", errorCode: "PAGE_ERROR" })
      }),
      expect.objectContaining({ type: "task_paused" })
    ]));
    database.close();
  });

  it("观察失败暂停后可通过安全重试重新观察并进入审核锁定", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";
    let activityListener: ((activity: WorkerActivity) => void) | undefined;
    const review = { ...snapshot("review"), taskId };
    const observe = vi.fn()
      .mockRejectedValueOnce(new Error("browser observation failed"))
      .mockResolvedValueOnce(review);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: {
        observe,
        execute: vi.fn(),
        onActivity(listener) {
          activityListener = listener;
          return () => undefined;
        }
      },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId, applicationUrl: "https://jobs.example.test/apply" });
    activityListener?.({ type: "page_stable", taskId, fingerprint: "page_fingerprint" });
    await vi.waitFor(() => expect(service.recoveryCommands(taskId)).toEqual(["retry_current", "cancel"]));

    await service.retryCurrent(taskId);

    expect(service.state(taskId).value).toBe("review_locked");
    expect(service.progress(taskId)).toMatchObject({ status: "idle", recovery: [] });
    expect(observe).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("invalidates a paused browser execution before retrying the current task", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";
    const login = { ...snapshot("login"), taskId };
    const observe = vi.fn(async () => login);
    const invalidateExecution = vi.fn(async (_taskId: string, _epoch: number) => undefined);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute: vi.fn(), invalidateExecution },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });
    service.start({ taskId, applicationUrl: login.url });
    await service.runUntilPause(taskId);

    await service.handleActivity({ type: "user_activity", taskId, fieldId: "field-password", activity: "input" });
    await vi.waitFor(() => expect(invalidateExecution).toHaveBeenCalledTimes(1));

    await service.retryCurrent(taskId);

    expect(invalidateExecution).toHaveBeenCalledTimes(2);
    const pauseEpoch = invalidateExecution.mock.calls[0]?.[1];
    const retryEpoch = invalidateExecution.mock.calls[1]?.[1];
    expect(retryEpoch).toBeGreaterThan(pauseEpoch!);
    expect(service.state(taskId).value).toBe("awaiting_login");
    database.close();
  });

  it("生产活动订阅隔离失败投影异常且不产生未处理拒绝", async () => {
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";
    let activityListener: ((activity: WorkerActivity) => void) | undefined;
    const checkpoints = {
      latest: () => undefined,
      list: () => [],
      save: vi.fn(() => { throw new Error("checkpoint write failed"); }),
      saveProgress: vi.fn(() => { throw new Error("progress write failed"); }),
      latestProgress: () => undefined
    };
    createApplicationService({
      checkpoints,
      browser: {
        observe: vi.fn(async () => { throw new Error("browser observation failed"); }),
        execute: vi.fn(),
        onActivity(listener) {
          activityListener = listener;
          return () => undefined;
        }
      },
      resolveField: async () => ({ status: "verified", value: "" }),
      approve: () => "unused"
    });

    expect(() => activityListener?.({ type: "page_stable", taskId, fingerprint: "page_fingerprint" })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("records a verified field as filled after successful readback", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-phone", label: "手机号码", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ nodeRef: fixtureNodeRef, id: "review", text: "预览", class: "terminal_submit" }]
    };
    const filled: FormSnapshot = {
      ...form,
      id: "snapshot-filled",
      fields: [{ ...form.fields[0]!, currentValue: "13800000000" }]
    };
    const checkpoints = createCheckpointRepository(database);
    const service = createApplicationService({
      checkpoints,
      browser: {
        observe: vi.fn(async () => form),
        execute: vi.fn(async () => ({
          type: "execution_result" as const,
          taskId: "task-1",
          snapshotId: filled.id,
          commandType: "fill" as const,
          status: "applied" as const,
          actualValue: "13800000000",
          snapshot: filled,
          errors: [],
          warnings: ["control_recovered_after_readback_mismatch"]
        }))
      },
      resolveField: async () => ({
        status: "verified" as const,
        value: "13800000000",
        assessment: {
          fieldId: "field-phone", label: "手机号码", semantic: "basics.phone",
          status: "ready" as const, source: "exact" as const, confidence: 1,
          reason: "精确匹配", evidence: []
        }
      }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(service.fieldCoverage("task-1")).toMatchObject({
      total: 1,
      review: 1,
      fields: [expect.objectContaining({
        fieldId: "field-phone",
        status: "review",
        reason: "已自动恢复并完成填写，建议在最终审核时确认实际选项"
      })]
    });
    expect(checkpoints.latest("task-1")?.fieldCoverage?.review).toBe(1);
    database.close();
  });

  it("replaces a prior missing assessment after the user fills the field in the controlled browser", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-manual", label: "Manual field", type: "text", required: true, options: [], currentValue: "" }],
      actions: [{ nodeRef: fixtureNodeRef, id: "review", text: "Review", class: "terminal_submit" }]
    };
    const manuallyFilled: FormSnapshot = {
      ...form,
      id: "snapshot-manual",
      fields: [{ ...form.fields[0]!, currentValue: "user value" }]
    };
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockResolvedValue(manuallyFilled);
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute: vi.fn() },
      resolveField: async () => ({
        status: "needs_question" as const,
        assessment: {
          fieldId: "field-manual", label: "Manual field", status: "missing" as const,
          source: "none" as const, confidence: 0, reason: "missing", evidence: []
        }
      }),
      approve: () => "unused"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    expect(service.fieldCoverage("task-1")?.fields).toContainEqual(expect.objectContaining({
      fieldId: "field-manual", status: "missing"
    }));

    await service.resumeWithProfile("task-1");

    expect(service.fieldCoverage("task-1")?.fields).toContainEqual(expect.objectContaining({
      fieldId: "field-manual", status: "filled", source: "user", confidence: 1
    }));
    database.close();
  });

  it("keeps a question pause intact when profile resumption cannot observe the page", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{
        id: "profile-resume-field",
        label: "Profile resume field",
        type: "text",
        required: true,
        options: [],
        currentValue: "",
        nodeRef: fixtureNodeRef
      }]
    };
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockRejectedValueOnce(new Error("observation failure"));
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute: vi.fn() },
      resolveField: async () => ({ status: "needs_question" as const, question: "Required" }),
      approve: () => "unused"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });
    await service.runUntilPause("task-1");
    expect(service.state("task-1").value).toBe("needs_questions");

    await expect(service.resumeWithProfile("task-1")).rejects.toThrow("observation failure");

    expect(service.state("task-1").value).toBe("needs_questions");
    database.close();
  });

  it("does not interrupt the task for an unknown optional field", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const checkpoints = createCheckpointRepository(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, id: "field-optional", label: "Additional Information", type: "textarea", required: false, options: [], currentValue: "" }],
      actions: [{ nodeRef: fixtureNodeRef, id: "action-submit", text: "Submit Application", class: "terminal_submit" }]
    };
    const service = createApplicationService({
      checkpoints,
      browser: { observe: async () => form, execute: vi.fn() },
      resolveField: async () => ({ status: "needs_question", question: "Missing optional answer" }),
      approve: () => "unused"
    });

    service.start({ taskId: "task-optional", applicationUrl: form.url });
    await service.runUntilPause("task-optional");

    expect(service.state("task-optional").value).toBe("review_locked");
    expect(service.state("task-optional").context.questions).toEqual([]);
    database.close();
  });

  it("continues later fields after a non-terminal field execution failure", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [
        { nodeRef: fixtureNodeRef, id: "field-month", label: "开始时间 月", type: "select", required: true, options: ["1", "2"], currentValue: "" },
        { nodeRef: fixtureNodeRef, id: "field-email", label: "邮箱", type: "text", required: true, options: [], currentValue: "" }
      ]
    };
    const filledEmail: FormSnapshot = {
      ...form,
      id: "snapshot-email-filled",
      fields: [form.fields[0]!, { ...form.fields[1]!, currentValue: "me@example.com" }]
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: form.id,
        commandType: "select" as const,
        status: "failed" as const,
        actualValue: null,
        snapshot: form,
        errors: ["option_not_found"]
      })
      .mockResolvedValueOnce({
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: form.id,
        commandType: "select" as const,
        status: "failed" as const,
        actualValue: null,
        snapshot: form,
        errors: ["option_not_found"]
      })
      .mockResolvedValueOnce({
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: filledEmail.id,
        commandType: "fill" as const,
        status: "applied" as const,
        actualValue: "me@example.com",
        snapshot: filledEmail,
        errors: []
      });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe: vi.fn(async () => form), execute },
      resolveField: async (_taskId, field) => ({
        status: "verified" as const,
        value: field.id === "field-month" ? "2" : "me@example.com",
        fieldPath: field.id,
        assessment: {
          fieldId: field.id,
          label: field.label,
          semantic: field.id,
          status: "ready" as const,
          source: "exact" as const,
          confidence: 1,
          reason: "ready",
          evidence: []
        }
      }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledTimes(3);
    expect(service.fieldCoverage("task-1")?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldId: "field-month", status: "failed", reason: "option_not_found" }),
      expect.objectContaining({ fieldId: "field-email", status: "filled" })
    ]));
    expect(service.state("task-1").value).toBe("needs_questions");
    database.close();
  });

  it("turns an unsafe semantic retry into a question without a false user pause", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const progressEvents: ProgressEventPayload[] = [];
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "field-award",
        label: "赛事名称",
        type: "select",
        required: true,
        options: [],
        currentValue: "",
        semanticHint: "awards[0].name"
      }]
    };
    const changed = { ...form, id: "snapshot-page-changed" };
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockResolvedValue(changed);
    const execute = vi.fn(async () => {
      throw new Error("custom_option_ambiguous");
    });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      taskEvents: captureProgressEvents(progressEvents),
      browser: { observe, execute },
      resolveField: async (_taskId, field, phase) => phase === "deterministic"
        ? { status: "deferred" as const, fieldPath: "awards[0].name" }
        : {
            status: "verified" as const,
            value: "全国大学生竞赛",
            fieldPath: "awards[0].name",
            assessment: {
              fieldId: field.id,
              label: field.label,
              semantic: field.semanticHint,
              status: "ready" as const,
              source: "semantic" as const,
              confidence: 0.92,
              reason: "semantic_match",
              evidence: []
            }
          },
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(service.state("task-1").value).toBe("needs_questions");
    expect(service.state("task-1").context.questions).toContainEqual(expect.objectContaining({
      fieldId: "field-award",
      fieldPath: "awards[0].name"
    }));
    expect(service.progress("task-1")).toMatchObject({ status: "idle", busy: false, recovery: [] });
    expect(progressEvents.some((event) => event.type === "task_paused")).toBe(false);

    await service.handleActivity({
      type: "page_unstable",
      taskId: "task-1",
      fingerprint: "delayed-dom-fluctuation"
    });

    expect(service.state("task-1").value).toBe("needs_questions");
    expect(service.progress("task-1")).toMatchObject({ status: "idle", busy: false, recovery: [] });
    expect(progressEvents.some((event) => event.type === "browser_activity")).toBe(true);
    expect(progressEvents.some((event) => event.type === "task_paused")).toBe(false);
    database.close();
  });

  it("搜索控件重渲染后使用稳定语义身份和保守专业名称完成第二次尝试", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const originalField: FormField = {nodeRef: fixtureNodeRef, 
      id: "field-major-before",
      label: "专业",
      type: "select",
      required: true,
      options: [],
      currentValue: "",
      controlKind: "custom",
      interactionMode: "search",
      sectionHint: "education",
      semanticHint: "education[0].major"
    };
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [originalField],
      actions: [{ nodeRef: fixtureNodeRef, id: "action-submit", text: "提交申请", class: "terminal_submit" }]
    };
    const rerendered: FormSnapshot = {
      ...form,
      id: "snapshot-rerendered",
      fields: [{
        ...originalField,
        id: "field-major-after",
        currentValue: "\u8f6f\u4ef6\u5de5\u7a0b\u4e13\u4e1a"
      }]
    };
    const filled: FormSnapshot = {
      ...rerendered,
      id: "snapshot-filled",
      fields: [{ ...rerendered.fields[0]!, currentValue: "软件工程" }]
    };
    const observe = vi.fn()
      .mockResolvedValueOnce(form)
      .mockResolvedValueOnce(rerendered)
      .mockResolvedValue(filled);
    const commands: ExecutableCommand[] = [];
    const execute = vi.fn(async (command: ExecutableCommand) => {
      commands.push(command);
      if (commands.length === 1) throw new Error("custom_option_not_found");
      return {
        type: "execution_result" as const,
        taskId: "task-1",
        snapshotId: filled.id,
        commandType: "select" as const,
        status: "applied" as const,
        actualValue: "软件工程",
        snapshot: filled,
        errors: []
      };
    });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: { observe, execute, invalidateExecution: vi.fn(async () => undefined) },
      resolveField: async (_taskId, field) => ({
        status: "verified" as const,
        value: "软件工程专业",
        fieldPath: "education[0].major",
        assessment: {
          fieldId: field.id,
          label: field.label,
          semantic: "education[0].major",
          status: "ready" as const,
          source: "exact" as const,
          confidence: 1,
          reason: "已确认档案精确匹配",
          evidence: []
        }
      }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(commands).toEqual([
      expect.objectContaining({ type: "select", fieldId: "field-major-before", value: "软件工程专业" }),
      expect.objectContaining({ type: "select", fieldId: "field-major-after", value: "软件工程" })
    ]);
    const attemptCounts = service.progress("task-1").attemptCountsByKey ?? {};
    expect(Object.keys(attemptCounts)).toHaveLength(1);
    expect(Object.keys(attemptCounts)[0]).toMatch(/^field-operation:/u);
    expect(Object.values(attemptCounts)).toEqual([2]);
    expect(service.state("task-1").value).toBe("review_locked");
    database.close();
  });

  it("搜索值没有保守归一化候选时不执行第二次搜索", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const form: FormSnapshot = {
      ...snapshot("application_form"),
      fields: [{ nodeRef: fixtureNodeRef, 
        id: "field-school",
        label: "学校",
        type: "select",
        required: true,
        options: [],
        currentValue: "",
        controlKind: "custom",
        interactionMode: "search",
        sectionHint: "education",
        semanticHint: "education[0].institution"
      }]
    };
    const execute = vi.fn(async () => {
      throw new Error("custom_option_not_found");
    });
    const service = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      browser: {
        observe: vi.fn(async () => form),
        execute,
        invalidateExecution: vi.fn(async () => undefined)
      },
      resolveField: async () => ({
        status: "verified" as const,
        value: "华南理工大学",
        fieldPath: "education[0].institution"
      }),
      approve: () => "approved-token"
    });
    service.start({ taskId: "task-1", applicationUrl: form.url });

    await service.runUntilPause("task-1");

    expect(execute).toHaveBeenCalledOnce();
    expect(service.progress("task-1")).toMatchObject({ status: "paused", busy: false });
    database.close();
  });

});
