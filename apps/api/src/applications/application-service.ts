import { randomUUID } from "node:crypto";
import type {
  ApplicationContentReview,
  ApplicationExecutionCounts,
  ApplicationFieldAssessment,
  ApplicationFieldCoverage,
  ApplicationQuestion,
  ApplicationDisplayPhase,
  ApplicationDisplayCategory,
  ApplicationTaskProgress,
  ApplicationTaskState,
  AdapterReviewSummary,
  CertifiedHintPack,
  ExecutableCommand,
  FormField,
  FormSnapshot,
  ProfileFact,
  WorkerActivity,
  WorkerResponse
} from "@resume/contracts";
import {
  applyCertifiedHintPack,
  classifyRepeatedActions,
  mokahrHintPack,
  type HintPackRegistry
} from "@resume/form-semantics";
import { createActor } from "xstate";
import {
  applicationMachine,
  sendApplicationEvent,
  type ApplicationActor,
  type ApplicationContext,
  type ApplicationStateValue
} from "./application-machine.js";
import {
  createChallengeCoordinator,
  type ChallengeCoordinator
} from "./challenge-coordinator.js";
import type {
  ApplicationCheckpoint,
  CheckpointRepository,
  StoredContentReview
} from "./checkpoint-repository.js";
import type { ApplicationTaskRepository } from "./application-task-repository.js";
import type { TaskEventBus } from "./task-events.js";
import {
  createApplicationProgressCoordinator,
  type ApplicationProgressSnapshot,
  type ApplicationRecoveryCommand,
  type StartOperationInput
} from "./application-progress.js";
import { deriveEntrySemanticHints } from "./entry-field-semantics.js";
import { annotateDjiFields } from "./dji-field-catalog.js";
import { createFieldCoverageStore } from "./field-coverage.js";
import { planRepeatedSectionActions } from "./repeated-section-planner.js";
import { compatibleExperienceIndexes } from "./experience-routing.js";
import { fieldOperationKey } from "./field-operation-key.js";
import { BrowserOwnershipLease } from "../browser/browser-ownership-lease.js";
import {
  createFullPageAuditCoordinator,
  type AuditMismatch,
  type FullPageAuditCoordinator,
  type FullPageAuditReason
} from "./full-page-audit.js";

type ExecutionResult = Extract<WorkerResponse, { type: "execution_result" }>;

interface BrowserPort {
  open?(taskId: string, url: string): Promise<unknown>;
  observe(taskId: string): Promise<FormSnapshot>;
  execute(command: ExecutableCommand, executionEpoch?: number): Promise<ExecutionResult>;
  invalidateExecution?(taskId: string, executionEpoch: number): Promise<void>;
  releaseTask?(taskId: string): Promise<void>;
  onActivity?(listener: (activity: WorkerActivity) => void): () => void;
}

export interface ApplicationService {
  start(input: StartApplicationInput): void;
  activeBrowserTaskId(): string | undefined;
  state(taskId: string): ApplicationServiceSnapshot;
  requiresRecovery(taskId: string): boolean;
  openBrowser(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  resumeAfterChallenge(taskId: string): Promise<void>;
  resumeAfterAdapterCertification(taskId: string): Promise<void>;
  resumeWithProfile(taskId: string): Promise<void>;
  refreshFromProfile(): Promise<void>;
  syncTaskFromProfile(taskId: string): Promise<void>;
  answerQuestions(taskId: string, answers: Record<string, unknown>): Promise<void>;
  contentReview(taskId: string): ContentReview | undefined;
  adapterReview(taskId: string): AdapterReviewSummary | undefined;
  fieldCoverage(taskId: string): ApplicationFieldCoverage | undefined;
  approveReview(taskId: string, reviewId: string, editedValue?: string): Promise<void>;
  rejectReview(taskId: string, reviewId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  dispose(taskId: string): void | Promise<void>;
  runUntilPause(taskId: string, initialSnapshot?: FormSnapshot): Promise<void>;
  requestIntermediateClick(taskId: string, actionId: string): Promise<void>;
  progress(taskId: string): ApplicationProgressSnapshot;
  recoveryCommands(taskId: string): ApplicationRecoveryCommand[];
  handleActivity(activity: WorkerActivity): Promise<void>;
  retryCurrent(taskId: string): Promise<void>;
  manualDone(taskId: string): Promise<void>;
}

export interface ApplicationServiceSnapshot {
  value: ApplicationStateValue;
  context: ApplicationContext;
}

export type ContentReview = StoredContentReview;

interface FieldResolution {
  status: "verified" | "deferred" | "needs_question" | "blocked";
  assessment?: ApplicationFieldAssessment;
  value?: unknown;
  question?: string;
  fieldPath?: string;
  requiresContentReview?: boolean;
  contentReview?: Pick<ApplicationContentReview, "original" | "reasons" | "evidence" | "unsupportedClaims" | "status">;
}

interface AdapterReviewServicePort {
  prepare(taskId: string, snapshot: FormSnapshot): Promise<AdapterReviewSummary>;
  retire(packId: string, version: string, reason: string): void;
}

interface ApplicationServiceDependencies {
  checkpoints: CheckpointRepository;
  taskRepository?: ApplicationTaskRepository;
  profileRevision?: () => number;
  taskEvents?: Pick<TaskEventBus, "emit" | "emitProgress">;
  browser: BrowserPort;
  browserOwnershipLease?: BrowserOwnershipLease;
  resolveField(
    taskId: string,
    field: FormField,
    phase?: "deterministic" | "semantic"
  ): Promise<FieldResolution>;
  approve(input: {
    taskId: string;
    snapshotId: string;
    targetId: string;
    operation: ExecutableCommand["type"];
    nodeRef: FormField["nodeRef"];
    executionEpoch: number;
  }, snapshot: FormSnapshot): string;
  applyAnswers?: (
    taskId: string,
    answers: Record<string, unknown>,
    fields: FormField[],
    questions?: ApplicationQuestion[]
  ) => Promise<void> | void;
  validateContentReview?: (review: ContentReview, editedValue: string) => string[];
  resolveFileId?: (taskId: string, field: FormField) => string | undefined;
  listProfileFacts?: () => readonly import("@resume/contracts").ProfileFact[];
  hintPackRegistry?: HintPackRegistry;
  adapterReviewService?: AdapterReviewServicePort;
}

export interface StartApplicationInput {
  taskId: string;
  applicationUrl: string;
}

export function createApplicationService(dependencies: ApplicationServiceDependencies): ApplicationService {
  const actors = new Map<string, ApplicationActor>();
  const browserOwnershipLease = dependencies.browserOwnershipLease ?? new BrowserOwnershipLease();
  const deriveSnapshot = (snapshot: FormSnapshot): FormSnapshot => withDerivedEntrySemantics(
    snapshot,
    dependencies.listProfileFacts?.() ?? []
  );

  const releaseTerminalBrowserTask = (): string | undefined => {
    const owner = browserOwnershipLease.current();
    if (owner?.ownerKind !== "application") return undefined;
    const actor = actors.get(owner.ownerId);
    if (actor && ["cancelled", "failed", "review_locked"].includes(actor.getSnapshot().value)) {
      browserOwnershipLease.release(owner);
      return undefined;
    }
    return owner.ownerId;
  };
  const reserveBrowserTask = (taskId: string): boolean => {
    releaseTerminalBrowserTask();
    const owner = browserOwnershipLease.current();
    const newlyReserved = owner?.ownerKind !== "application" || owner.ownerId !== taskId;
    try {
      browserOwnershipLease.acquire({ ownerKind: "application", ownerId: taskId });
    } catch (error) {
      if (error instanceof Error && error.message === "browser_lease_in_use") {
        throw new Error("browser_task_in_use");
      }
      throw error;
    }
    return newlyReserved;
  };
  const releaseBrowserTask = (taskId: string): void => {
    const owner = browserOwnershipLease.current();
    if (owner?.ownerKind === "application" && owner.ownerId === taskId) {
      browserOwnershipLease.release(owner);
    }
  };
  const latestSnapshots = new Map<string, FormSnapshot>();
  const contentReviews = new Map<string, ContentReview>();
  const adapterReviews = new Map<string, AdapterReviewSummary>();
  const activeHintPacks = new Map<string, CertifiedHintPack>();
  const recoveryCheckpoints = new Map<string, ApplicationCheckpoint>();
  const lastPublishedStates = new Map<string, ApplicationTaskState>();
  const stableActivities = new Map<string, Promise<void>>();
  const activeRuns = new Map<string, Promise<void>>();
  const applicationFormsReached = new Set<string>();
  const retryReadbacks = new Set<string>();
  const runGenerations = new Map<string, number>();
  const executionEpochs = new Map<string, number>();
  const fullPageAudits = new Map<string, FullPageAuditCoordinator>();
  const fullPageAuditOperations = new Map<string, Map<string, StartOperationInput>>();
  let challengeCoordinator: ChallengeCoordinator;
  const fieldCoverageStore = createFieldCoverageStore();
  const progress = createApplicationProgressCoordinator({
    emit(taskId, event) {
      if (event.type !== "state_changed") dependencies.taskEvents?.emitProgress(taskId, event);
    },
    persist(taskId, snapshot) {
      dependencies.checkpoints.saveProgress(taskId, snapshot);
    }
  });

  const publishCoverageCounts = (taskId: string): void => {
    const coverage = fieldCoverageStore.snapshot(taskId);
    if (coverage === undefined) return;
    const counts: ApplicationExecutionCounts = {
      exact: coverage.fields.filter((field) =>
        field.status === "filled"
        && (field.source === "exact" || field.source === "dji_catalog" || field.source === "certified_hint")).length,
      semantic: coverage.fields.filter((field) =>
        field.status === "filled" && field.source === "semantic").length,
      user: coverage.fields.filter((field) =>
        field.status === "filled" && field.source === "user").length,
      missing: coverage.fields.filter((field) =>
        field.status === "missing" || field.status === "unsupported" || field.status === "review").length,
      failed: coverage.failed
    };
    const current = progress.snapshot(taskId).executionProgress?.counts;
    if (current !== undefined && Object.keys(counts).every((key) =>
      counts[key as keyof ApplicationExecutionCounts] === current[key as keyof ApplicationExecutionCounts])) return;
    progress.setCounts(taskId, counts);
  };

  const enterFinalReview = (taskId: string): void => {
    progress.setPhase(taskId, "final_review", "running");
  };

  const requireActor = (taskId: string): ApplicationActor => {
    const existing = actors.get(taskId);
    if (existing) return existing;
    const checkpoint = dependencies.checkpoints.latest(taskId);
    if (!checkpoint) throw new Error("application_task_not_found");
    const actor = createActor(applicationMachine, {
      input: { taskId, applicationUrl: checkpoint.url }
    }).start();
    sendApplicationEvent(actor, { type: "START" });
    restoreActor(actor, checkpoint.state, checkpoint.questions, checkpoint.snapshot?.challenge);
    actors.set(taskId, actor);
    if (["created", "observing", "filling", "validating", "navigating"].includes(checkpoint.state)) {
      recoveryCheckpoints.set(taskId, checkpoint);
    }
    if (checkpoint.snapshot) {
      latestSnapshots.set(taskId, checkpoint.snapshot);
      if (isApplicationFormReady(checkpoint.snapshot)) applicationFormsReached.add(taskId);
    }
    if (checkpoint.contentReview) contentReviews.set(taskId, checkpoint.contentReview);
    if (checkpoint.adapterReview) adapterReviews.set(taskId, checkpoint.adapterReview);
    if (checkpoint.fieldCoverage) fieldCoverageStore.restore(taskId, checkpoint.fieldCoverage);
    const storedProgress = dependencies.checkpoints.latestProgress(taskId);
    if (storedProgress) progress.restore(taskId, storedProgress);
    return actor;
  };

  const persist = (actor: ApplicationActor, snapshot: FormSnapshot): void => {
    const machineState = actor.getSnapshot();
    const taskId = machineState.context.taskId;
    fieldCoverageStore.retain(taskId, new Set(snapshot.fields.map((field) => field.id)));
    for (const field of snapshot.fields) {
      if (hasUserValue(field.currentValue)) {
        fieldCoverageStore.markUserFilled(taskId, {
          fieldId: field.id,
          label: field.label,
          ...(field.semanticHint === undefined ? {} : { semantic: field.semanticHint })
        });
      }
    }
    const coverage = fieldCoverageStore.snapshot(taskId);
    publishCoverageCounts(taskId);
    dependencies.checkpoints.save({
      taskId,
      state: machineState.value as ApplicationStateValue,
      url: snapshot.url,
      stage: snapshot.stage,
      snapshotId: snapshot.id,
      fieldIds: snapshot.fields.map((field) => field.id),
      questions: machineState.context.questions,
      snapshot,
      ...(coverage === undefined ? {} : { fieldCoverage: coverage }),
      ...(contentReviews.get(machineState.context.taskId) === undefined
        ? {}
        : { contentReview: contentReviews.get(machineState.context.taskId)! }),
      ...(adapterReviews.get(machineState.context.taskId) === undefined
        ? {}
        : { adapterReview: adapterReviews.get(machineState.context.taskId)! })
    });
    const state = toApiState(machineState.value as ApplicationStateValue);
    if (lastPublishedStates.get(machineState.context.taskId) !== state) {
      dependencies.taskEvents?.emit(machineState.context.taskId, state);
      lastPublishedStates.set(machineState.context.taskId, state);
    }
    releaseTerminalBrowserTask();
  };

  const fullPageAuditFor = (taskId: string): FullPageAuditCoordinator => {
    const existing = fullPageAudits.get(taskId);
    if (existing !== undefined) return existing;
    const created = createFullPageAuditCoordinator(taskId);
    fullPageAudits.set(taskId, created);
    return created;
  };

  const auditOperationsFor = (taskId: string): Map<string, StartOperationInput> => {
    const existing = fullPageAuditOperations.get(taskId);
    if (existing !== undefined) return existing;
    const created = new Map<string, StartOperationInput>();
    fullPageAuditOperations.set(taskId, created);
    return created;
  };

  const runFullPageAudit = async (
    taskId: string,
    actor: ApplicationActor,
    current: FormSnapshot,
    reason: FullPageAuditReason
  ): Promise<{ snapshot: FormSnapshot; mismatches: AuditMismatch[]; challenged: boolean }> => {
    const coordinator = fullPageAuditFor(taskId);
    if (current.stage !== "application_form"
      || auditOperationsFor(taskId).size === 0
      || !coordinator.shouldAudit(reason)) {
      return { snapshot: current, mismatches: [], challenged: false };
    }

    const observed = await dependencies.browser.observe(taskId);
    const prepared = await prepareObservedSnapshot(taskId, actor, observed);
    if (prepared === undefined) {
      return { snapshot: observed, mismatches: [], challenged: true };
    }
    const mismatches = coordinator.audit(prepared);
    for (const mismatch of mismatches) {
      fieldCoverageStore.markFailed(taskId, mismatch.fieldId, "controlled_value_reverted");
      const operation = auditOperationsFor(taskId).get(mismatch.operationKey);
      if (operation !== undefined) progress.recordFailure(operation, "READBACK_MISMATCH");
    }
    if (mismatches.length > 0 && await quarantineActivePack(taskId, actor, "unsafe mapping", observed)) {
      return { snapshot: observed, mismatches, challenged: true };
    }
    persist(actor, prepared);
    return { snapshot: prepared, mismatches, challenged: false };
  };

  const nextRunGeneration = (taskId: string): number => {
    const generation = (runGenerations.get(taskId) ?? 0) + 1;
    runGenerations.set(taskId, generation);
    return generation;
  };

  const nextExecutionEpoch = (taskId: string): number => {
    const epoch = (executionEpochs.get(taskId) ?? 0) + 1;
    executionEpochs.set(taskId, epoch);
    return epoch;
  };

  const invalidateExecution = async (taskId: string): Promise<number> => {
    const epoch = nextExecutionEpoch(taskId);
    await dependencies.browser.invalidateExecution?.(taskId, epoch);
    return epoch;
  };

  const pauseForChallenge = async (
    actor: ApplicationActor,
    snapshot: FormSnapshot
  ): Promise<boolean> => {
    latestSnapshots.set(actor.getSnapshot().context.taskId, snapshot);
    return challengeCoordinator.pause(actor, snapshot);
  };

  const prepareObservedSnapshot = async (
    taskId: string,
    actor: ApplicationActor,
    observed: FormSnapshot
  ): Promise<FormSnapshot | undefined> => {
    latestSnapshots.set(taskId, observed);
    if (await pauseForChallenge(actor, observed)) return undefined;
    if (observed.stage !== "application_form"
      || dependencies.hintPackRegistry === undefined
      || dependencies.adapterReviewService === undefined) {
      return deriveSnapshot(observed);
    }

    const adapterResolution = dependencies.hintPackRegistry.resolve(observed);
    if (adapterResolution.kind === "review_only") {
      if (adapterResolution.reason === "fingerprint_mismatch") {
        for (const pack of adapterResolution.mismatchedPacks) {
          dependencies.adapterReviewService.retire(pack.packId, pack.version, "superseded mapping");
        }
      }
      activeHintPacks.delete(taskId);
      await invalidateExecution(taskId);
      invalidateRunGeneration(taskId);
      adapterReviews.set(taskId, await dependencies.adapterReviewService.prepare(taskId, observed));
      if (actor.getSnapshot().value !== "awaiting_adapter_review") {
        sendApplicationEvent(actor, { type: "ADAPTER_REVIEW_REQUIRED" });
      }
      persist(actor, observed);
      return undefined;
    }

    activeHintPacks.set(taskId, adapterResolution.pack);
    return withDerivedEntrySemantics(
      applyCertifiedHintPack(observed, adapterResolution.pack),
      dependencies.listProfileFacts?.() ?? []
    );
  };

  const classifiedRepeatedActions = (taskId: string, snapshot: FormSnapshot) => {
    const activePack = activeHintPacks.get(taskId);
    if (activePack !== undefined) return classifyRepeatedActions(snapshot, activePack);
    // Legacy in-process test composition omits the production registry entirely.
    if (dependencies.hintPackRegistry === undefined && dependencies.adapterReviewService === undefined) {
      return classifyRepeatedActions(snapshot, mokahrHintPack);
    }
    return [];
  };

  const invalidateRunGeneration = (taskId: string): number => {
    const generation = (runGenerations.get(taskId) ?? 0) + 1;
    runGenerations.set(taskId, generation);
    return generation;
  };

  const quarantineActivePack = async (
    taskId: string,
    actor: ApplicationActor,
    reason: string,
    snapshot: FormSnapshot
  ): Promise<boolean> => {
    const pack = activeHintPacks.get(taskId);
    if (pack === undefined || dependencies.adapterReviewService === undefined) return false;
    dependencies.adapterReviewService.retire(pack.packId, pack.version, reason);
    activeHintPacks.delete(taskId);
    await invalidateExecution(taskId);
    invalidateRunGeneration(taskId);
    adapterReviews.set(taskId, await dependencies.adapterReviewService.prepare(taskId, snapshot));
    if (actor.getSnapshot().value !== "awaiting_adapter_review") {
      sendApplicationEvent(actor, { type: "ADAPTER_REVIEW_REQUIRED" });
    }
    persist(actor, snapshot);
    return true;
  };

  const invalidateRun = (taskId: string): number => {
    const generation = invalidateRunGeneration(taskId);
    void invalidateExecution(taskId).catch(() => undefined);
    return generation;
  };

  const executeWithSignedEpoch = (command: ExecutableCommand): Promise<ExecutionResult> =>
    dependencies.browser.execute(command, command.executionEpoch);

  const runIsLive = (taskId: string, generation: number, actor: ApplicationActor): boolean =>
    runGenerations.get(taskId) === generation
    && actor.getSnapshot().value !== "cancelled"
    && actor.getSnapshot().value !== "awaiting_challenge"
    && actor.getSnapshot().value !== "awaiting_adapter_review";

  const runIsCurrent = (taskId: string, generation: number, actor: ApplicationActor): boolean =>
    runIsLive(taskId, generation, actor)
    && progress.snapshot(taskId).status !== "paused";

  const pauseAfterExecutionFailure = (
    actor: ApplicationActor,
    operation: StartOperationInput,
    result: ExecutionResult
  ): void => {
    if (isTerminalSafetyBlock(result)) {
      sendApplicationEvent(actor, { type: "FAIL", errors: result.errors });
      return;
    }
    progress.recordFailure(
      operation,
      result.status === "blocked" ? "READBACK_MISMATCH" : "PAGE_ERROR"
    );
    const state = actor.getSnapshot().value;
    if (state === "filling" || state === "validating" || state === "navigating" || state === "failed") {
      sendApplicationEvent(actor, { type: "RECOVER" });
    }
  };

  const service: ApplicationService & {
    runUntilPauseInternal(taskId: string, initialSnapshot?: FormSnapshot): Promise<void>;
  } = {
    start(input: StartApplicationInput): void {
      if (actors.has(input.taskId)) throw new Error(`投递任务已存在：${input.taskId}`);
      const actor = createActor(applicationMachine, { input }).start();
      sendApplicationEvent(actor, { type: "START" });
      actors.set(input.taskId, actor);
      const storedProgress = dependencies.checkpoints.latestProgress(input.taskId);
      if (storedProgress) progress.restore(input.taskId, storedProgress);
      else progress.setPhase(input.taskId, "waiting_for_form", "running");
    },

    activeBrowserTaskId(): string | undefined {
      return releaseTerminalBrowserTask();
    },

    state(taskId: string) {
      return requireActor(taskId).getSnapshot();
    },

    requiresRecovery(taskId: string) {
      requireActor(taskId);
      return recoveryCheckpoints.has(taskId);
    },

    contentReview(taskId: string) {
      return contentReviews.get(taskId);
    },

    adapterReview(taskId: string) {
      return adapterReviews.get(taskId);
    },

    fieldCoverage(taskId: string) {
      requireActor(taskId);
      return fieldCoverageStore.snapshot(taskId);
    },

    progress(taskId: string) {
      requireActor(taskId);
      return progress.snapshot(taskId);
    },

    recoveryCommands(taskId: string) {
      requireActor(taskId);
      return progress.snapshot(taskId).recovery;
    },

    async openBrowser(taskId: string): Promise<void> {
      const actor = requireActor(taskId);
      if (recoveryCheckpoints.has(taskId)) throw new Error("checkpoint_recovery_requires_resume");
      if (!dependencies.browser.open) throw new Error("browser_open_unavailable");
      const newlyReserved = reserveBrowserTask(taskId);
      try {
        await dependencies.browser.open(taskId, actor.getSnapshot().context.applicationUrl);
      } catch (error) {
        if (newlyReserved) releaseBrowserTask(taskId);
        throw error;
      }
    },

    async resume(taskId: string): Promise<void> {
      const storedState = actors.get(taskId)?.getSnapshot().value
        ?? dependencies.checkpoints.latest(taskId)?.state;
      if (storedState === "awaiting_challenge") throw new Error("challenge_resume_not_allowed");
      const newlyReserved = reserveBrowserTask(taskId);
      try {
        const existingActor = actors.get(taskId);
        if (existingActor) {
          const recoveryCheckpoint = recoveryCheckpoints.get(taskId);
          if (recoveryCheckpoint) {
            const observed = await dependencies.browser.observe(taskId);
            const prepared = await prepareObservedSnapshot(taskId, existingActor, observed);
            if (prepared === undefined) return;
            if (observed.stage !== "login" && !matchesCheckpoint(observed, recoveryCheckpoint)) {
              actors.delete(taskId);
              recoveryCheckpoints.delete(taskId);
              throw new Error("checkpoint_mismatch");
            }
            if (prepared.stage === "login") {
              sendApplicationEvent(existingActor, { type: "LOGIN_REQUIRED" });
            }
            latestSnapshots.set(taskId, prepared);
            recoveryCheckpoints.delete(taskId);
            persist(existingActor, prepared);
            return;
          }
          if (existingActor.getSnapshot().value !== "awaiting_login") {
            throw new Error(`投递任务已在当前进程恢复：${taskId}`);
          }
          const observed = await dependencies.browser.observe(taskId);
          if (observed.stage !== "login") {
            sendApplicationEvent(existingActor, { type: "RESUME" });
          }
          const prepared = await prepareObservedSnapshot(taskId, existingActor, observed);
          if (prepared === undefined) return;
          latestSnapshots.set(taskId, prepared);
          persist(existingActor, prepared);
          return;
        }
        const checkpoint = dependencies.checkpoints.latest(taskId);
        if (!checkpoint) throw new Error(`投递任务检查点不存在：${taskId}`);
        const actor = createActor(applicationMachine, {
          input: { taskId, applicationUrl: checkpoint.url }
        }).start();
        sendApplicationEvent(actor, { type: "START" });
        restoreActor(actor, checkpoint.state, checkpoint.questions, checkpoint.snapshot?.challenge);
        actors.set(taskId, actor);

        const observed = await dependencies.browser.observe(taskId);
        if (checkpoint.state === "awaiting_login"
          && actor.getSnapshot().value === "awaiting_login"
          && observed.stage !== "login") {
          sendApplicationEvent(actor, { type: "RESUME" });
        }
        const prepared = await prepareObservedSnapshot(taskId, actor, observed);
        if (prepared === undefined) return;
        if (checkpoint.state !== "awaiting_login" && !matchesCheckpoint(prepared, checkpoint)) {
          actors.delete(taskId);
          throw new Error("checkpoint_mismatch");
        }
        if (checkpoint.state === "awaiting_login" && actor.getSnapshot().value === "awaiting_login") {
          sendApplicationEvent(actor, { type: "RESUME" });
        }
        latestSnapshots.set(taskId, prepared);
        persist(actor, prepared);
      } catch (error) {
        if (newlyReserved) releaseBrowserTask(taskId);
        throw error;
      }
    },

    async resumeAfterChallenge(taskId: string): Promise<void> {
      const newlyReserved = reserveBrowserTask(taskId);
      try {
        await challengeCoordinator.resume(requireActor(taskId));
      } catch (error) {
        if (newlyReserved) releaseBrowserTask(taskId);
        throw error;
      }
    },

    async resumeAfterAdapterCertification(taskId: string): Promise<void> {
      const actor = requireActor(taskId);
      if (actor.getSnapshot().value !== "awaiting_adapter_review") {
        throw new Error("adapter_review_resume_not_allowed");
      }
      if (dependencies.hintPackRegistry === undefined || dependencies.adapterReviewService === undefined) {
        throw new Error("adapter_not_certified");
      }
      const newlyReserved = reserveBrowserTask(taskId);
      try {
        const observed = await dependencies.browser.observe(taskId);
        const prepared = await prepareObservedSnapshot(taskId, actor, observed);
        if (prepared === undefined) {
          if (actor.getSnapshot().value === "awaiting_challenge") return;
          throw new Error("adapter_not_certified");
        }
        invalidateRunGeneration(taskId);
        await invalidateExecution(taskId);
        sendApplicationEvent(actor, { type: "ADAPTER_CERTIFIED" });
        adapterReviews.delete(taskId);
        latestSnapshots.set(taskId, prepared);
        persist(actor, prepared);
        await service.runUntilPause(taskId, prepared);
      } catch (error) {
        if (newlyReserved) releaseBrowserTask(taskId);
        throw error;
      }
    },

    async answerQuestions(taskId: string, answers: Record<string, unknown>): Promise<void> {
      const actor = requireActor(taskId);
      if (actor.getSnapshot().value !== "needs_questions") {
        throw new Error(`状态 ${String(actor.getSnapshot().value)} 不允许回答追问`);
      }
      const snapshot = latestSnapshots.get(taskId);
      if (!snapshot) throw new Error("current_snapshot_missing");
      if (!dependencies.applyAnswers) throw new Error("answer_persistence_unavailable");
      const expectedIds = actor.getSnapshot().context.questions.map((question) => question.id).sort();
      const receivedIds = Object.keys(answers).sort();
      if (expectedIds.length !== receivedIds.length
        || expectedIds.some((id, index) => id !== receivedIds[index])) {
        throw new Error("incomplete_question_answers");
      }
      try {
        await dependencies.applyAnswers(
          taskId,
          answers,
          snapshot.fields,
          actor.getSnapshot().context.questions
        );
      } catch {
        throw new Error("answer_persistence_failed");
      }
      sendApplicationEvent(actor, { type: "ANSWERS_PROVIDED" });
      persist(actor, snapshot);
    },

    async resumeWithProfile(taskId: string): Promise<void> {
      const actor = requireActor(taskId);
      if (actor.getSnapshot().value !== "needs_questions") throw new Error("profile_resumption_not_allowed");
      const newlyReserved = reserveBrowserTask(taskId);
      try {
        const observed = await dependencies.browser.observe(taskId);
        const prepared = await prepareObservedSnapshot(taskId, actor, observed);
        if (prepared === undefined) return;
        sendApplicationEvent(actor, { type: "PROFILE_UPDATED" });
        latestSnapshots.set(taskId, prepared);
        persist(actor, prepared);
        await service.runUntilPause(taskId, prepared);
      } catch (error) {
        if (newlyReserved) releaseBrowserTask(taskId);
        throw error;
      }
    },

    async refreshFromProfile(): Promise<void> {
      const revision = dependencies.profileRevision?.();
      const taskIds = dependencies.taskRepository === undefined
        ? [...actors.keys()]
        : dependencies.taskRepository.list().map((task) => task.id);
      const candidates = taskIds.filter((taskId) => {
        const actor = actors.get(taskId);
        if (actor === undefined && dependencies.taskRepository?.get(taskId) === undefined) return false;
        if (revision !== undefined) {
          const task = dependencies.taskRepository?.get(taskId);
          if (task !== undefined && task.profileSyncStatus === "current" && task.profileRevisionApplied >= revision) return false;
        }
        const state = actor?.getSnapshot().value ?? dependencies.checkpoints.latest(taskId)?.state;
        return state === "needs_questions" || (actor !== undefined && state === "observing");
      });
      for (const taskId of candidates) {
        dependencies.taskRepository?.markProfileSyncPending(taskId);
        try {
          const actor = requireActor(taskId);
          if (actor.getSnapshot().value === "needs_questions") {
            await service.resumeWithProfile(taskId);
          } else await service.runUntilPause(taskId);
          const finalState = requireActor(taskId).getSnapshot().value;
          if (revision !== undefined && dependencies.taskRepository !== undefined
            && finalState !== "failed" && finalState !== "needs_questions") {
            dependencies.taskRepository.markProfileSyncSucceeded(taskId, revision);
          } else if (finalState === "failed") {
            dependencies.taskRepository?.markProfileSyncFailed(taskId, "profile_refresh_failed");
          } else if (finalState === "needs_questions") {
            dependencies.taskRepository?.markProfileSyncFailed(taskId, "profile_sync_incomplete");
          }
        } catch (error) {
          dependencies.taskRepository?.markProfileSyncFailed(
            taskId,
            error instanceof Error ? error.message.slice(0, 200) : "profile_refresh_failed"
          );
        }
      }
    },

    async syncTaskFromProfile(taskId: string): Promise<void> {
      const revision = dependencies.profileRevision?.();
      const task = dependencies.taskRepository?.get(taskId);
      if (task !== undefined && task.profileSyncStatus === "pending") throw new Error("profile_sync_in_progress");
      dependencies.taskRepository?.markProfileSyncPending(taskId);
      try {
        const actor = requireActor(taskId);
        const state = actor.getSnapshot().value;
        if (["review_locked", "cancelled", "awaiting_login"].includes(String(state))) {
          throw new Error("profile_sync_not_allowed");
        }
        if (state === "needs_questions") {
          await service.resumeWithProfile(taskId);
        } else {
          if (state === "failed") sendApplicationEvent(actor, { type: "RECOVER" });
          await service.runUntilPause(taskId);
        }
        const finalState = requireActor(taskId).getSnapshot().value;
        if (finalState === "failed" || finalState === "needs_questions") throw new Error("profile_sync_incomplete");
        if (revision !== undefined) dependencies.taskRepository?.markProfileSyncSucceeded(taskId, revision);
      } catch (error) {
        dependencies.taskRepository?.markProfileSyncFailed(
          taskId,
          error instanceof Error ? error.message.slice(0, 200) : "profile_sync_failed"
        );
        throw error;
      }
    },


    async approveReview(taskId: string, reviewId: string, editedValue?: string): Promise<void> {
      const actor = requireActor(taskId);
      if (actor.getSnapshot().value !== "awaiting_content_review") {
        throw new Error("content_review_not_allowed");
      }
      const review = contentReviews.get(taskId);
      if (!review || review.id !== reviewId || review.taskId !== taskId) {
        throw new Error("content_review_mismatch");
      }
      const snapshot = latestSnapshots.get(taskId);
      if (!snapshot) throw new Error("current_snapshot_missing");
      if (!dependencies.applyAnswers) throw new Error("answer_persistence_unavailable");
      const finalValue = editedValue ?? review.draft;
      if (!dependencies.validateContentReview) throw new Error("content_review_validation_unavailable");
      if (dependencies.validateContentReview(review, finalValue).length > 0) {
        throw new Error("content_review_unsupported_edit");
      }
      try {
        await dependencies.applyAnswers(
          taskId,
          { [review.fieldId]: finalValue },
          snapshot.fields
        );
      } catch {
        throw new Error("content_review_persistence_failed");
      }
      contentReviews.set(taskId, {
        ...review,
        draft: finalValue,
        status: "approved"
      });
      sendApplicationEvent(actor, { type: "CONTENT_APPROVED" });
      persist(actor, snapshot);
    },

    async rejectReview(taskId: string, reviewId: string): Promise<void> {
      const actor = requireActor(taskId);
      if (actor.getSnapshot().value !== "awaiting_content_review") {
        throw new Error("content_review_not_allowed");
      }
      const review = contentReviews.get(taskId);
      if (!review || review.id !== reviewId || review.taskId !== taskId) {
        throw new Error("content_review_mismatch");
      }
      sendApplicationEvent(actor, { type: "CONTENT_REJECTED" });
      const snapshot = latestSnapshots.get(taskId);
      if (!snapshot) throw new Error("current_snapshot_missing");
      contentReviews.delete(taskId);
      persist(actor, snapshot);
    },

    async cancel(taskId: string): Promise<void> {
      const actor = requireActor(taskId);
      invalidateRunGeneration(taskId);
      progress.cancel(taskId);
      recoveryCheckpoints.delete(taskId);
      await invalidateExecution(taskId).catch(() => undefined);
      await dependencies.browser.releaseTask?.(taskId).catch(() => undefined);
      sendApplicationEvent(actor, { type: "CANCEL" });
      releaseBrowserTask(taskId);
      const snapshot = latestSnapshots.get(taskId);
      if (snapshot) persist(actor, snapshot);
    },

    dispose(taskId: string): void {
      invalidateRun(taskId);
      progress.dispose(taskId);
      fieldCoverageStore.dispose(taskId);
      actors.get(taskId)?.stop();
      actors.delete(taskId);
      latestSnapshots.delete(taskId);
      contentReviews.delete(taskId);
      adapterReviews.delete(taskId);
      activeHintPacks.delete(taskId);
      recoveryCheckpoints.delete(taskId);
      lastPublishedStates.delete(taskId);
      stableActivities.delete(taskId);
      applicationFormsReached.delete(taskId);
      retryReadbacks.delete(taskId);
      runGenerations.delete(taskId);
      executionEpochs.delete(taskId);
      fullPageAudits.delete(taskId);
      fullPageAuditOperations.delete(taskId);
      releaseBrowserTask(taskId);
    },

    async runUntilPause(taskId: string, initialSnapshot?: FormSnapshot): Promise<void> {
      const active = activeRuns.get(taskId);
      if (active) return active;
      const run = service.runUntilPauseInternal(taskId, initialSnapshot);
      activeRuns.set(taskId, run);
      try {
        await run;
      } catch (error) {
        if (!isCancellation(error)) throw error;
      } finally {
        if (activeRuns.get(taskId) === run) activeRuns.delete(taskId);
      }
    },

    async runUntilPauseInternal(taskId: string, initialSnapshot?: FormSnapshot): Promise<void> {
      const actor = requireActor(taskId);
      if (actor.getSnapshot().value === "review_locked") return;
      if (actor.getSnapshot().value === "awaiting_challenge"
        || actor.getSnapshot().value === "awaiting_adapter_review") return;
      if (progress.snapshot(taskId).status === "paused") return;
      const runGeneration = nextRunGeneration(taskId);
      let page: FormSnapshot;
      if (initialSnapshot) page = initialSnapshot;
      else {
        try {
          page = await progress.runOperation(operationInput(taskId, "observe", "page", "页面状态", 1, 1, 10_000),
            () => dependencies.browser.observe(taskId));
        } catch (error) {
          if (isCancellation(error)) return;
          throw error;
        }
      }
      const preparedPage = await prepareObservedSnapshot(taskId, actor, page);
      if (preparedPage === undefined) return;
      page = preparedPage;
      if (!runIsCurrent(taskId, runGeneration, actor)) return;
      latestSnapshots.set(taskId, page);
      persist(actor, page);

      if (page.stage === "review" || page.stage === "success") {
        enterFinalReview(taskId);
        sendApplicationEvent(actor, { type: "REVIEW_REACHED" });
        persist(actor, page);
        return;
      }
      if (page.stage === "login") {
        progress.setPhase(taskId, "waiting_for_form", "running");
        if (actor.getSnapshot().value !== "awaiting_login") {
          sendApplicationEvent(actor, { type: "LOGIN_REQUIRED" });
        }
        persist(actor, page);
        return;
      }
      if (!applicationFormsReached.has(taskId)) {
        if (!isApplicationFormReady(page)) {
          progress.setPhase(taskId, "waiting_for_form", "running");
          return;
        }
        applicationFormsReached.add(taskId);
      }
      progress.setPhase(taskId, "waiting_for_form", "completed");

      const repeatedAction = planRepeatedSectionActions(
        page,
        dependencies.listProfileFacts?.() ?? [],
        classifiedRepeatedActions(taskId, page)
      )[0];
      if (repeatedAction) {
        const profileFacts = dependencies.listProfileFacts?.() ?? [];
        const action = page.actions.find((candidate) => candidate.id === repeatedAction.actionId);
        if (action === undefined) throw new Error("repeated_section_action_not_found");
        const executionEpoch = nextExecutionEpoch(taskId);
        const approval = dependencies.approve({
          taskId,
          snapshotId: page.id,
          targetId: repeatedAction.actionId,
          operation: "click_intermediate",
          nodeRef: action.nodeRef,
          executionEpoch
        }, page);
        const operation = operationInput(taskId, "navigate", repeatedAction.actionId, "项目经历", 1, 1, 15_000);
        const result = await progress.runOperation(operation, () => executeWithSignedEpoch({
          type: "click_intermediate",
          taskId,
          snapshotId: page.id,
          actionId: repeatedAction.actionId,
          nodeRef: action.nodeRef,
          executionEpoch,
          approval
        }));
        if (!runIsCurrent(taskId, runGeneration, actor)) return;
        const expanded = await prepareObservedSnapshot(taskId, actor, result.snapshot);
        if (expanded === undefined) return;
        if (isPackReadbackRegression(result)
          && await quarantineActivePack(taskId, actor, "unsafe mapping", result.snapshot)) return;
        persist(actor, expanded);
        if (result.status !== "applied") {
          pauseAfterExecutionFailure(actor, operation, result);
          persist(actor, expanded);
          return;
        }
        let observed: FormSnapshot;
        try {
          observed = await progress.runOperation(
            operationInput(taskId, "observe", "page", "页面状态", 1, 1, 10_000),
            () => dependencies.browser.observe(taskId)
          );
        } catch (error) {
          if (isCancellation(error)) return;
          throw error;
        }
        if (!runIsCurrent(taskId, runGeneration, actor)) return;
        const verified = await prepareObservedSnapshot(taskId, actor, observed);
        if (verified === undefined) return;
        const remaining = planRepeatedSectionActions(
          verified,
          profileFacts,
          classifiedRepeatedActions(taskId, verified)
        )
          .find((candidate) => candidate.section === repeatedAction.section)?.missingEntries ?? 0;
        if (remaining >= repeatedAction.missingEntries) {
          progress.recordFailure(operation, "READBACK_MISMATCH");
          persist(actor, verified);
          return;
        }
        persist(actor, verified);
        await service.runUntilPauseInternal(taskId, verified);
        return;
      }

      const resumeField = page.fields.find((field) =>
        isResumeUploadField(field)
        && !hasUserValue(field.currentValue)
        && dependencies.resolveFileId?.(taskId, field) !== undefined
      );
      if (resumeField) {
        const command = fieldCommand(
          page,
          resumeField,
          undefined,
          nextExecutionEpoch(taskId),
          dependencies.approve,
          dependencies.resolveFileId
        );
        const uploadOperation = operationInput(taskId, "upload", resumeField.id, "附件", 1, 1, 60_000);
        const result = await progress.runWithPolicy(
          uploadOperation,
          () => executeWithSignedEpoch(command)
        );
        if (!runIsCurrent(taskId, runGeneration, actor)) return;
        const uploadSnapshot = await prepareObservedSnapshot(taskId, actor, result.snapshot);
        if (uploadSnapshot === undefined) return;
        if (isPackReadbackRegression(result)
          && await quarantineActivePack(taskId, actor, "unsafe mapping", result.snapshot)) return;
        if (result.status !== "applied") {
          pauseAfterExecutionFailure(actor, uploadOperation, result);
          persist(actor, uploadSnapshot);
          return;
        }
        page = uploadSnapshot;
        persist(actor, page);
        if (planRepeatedSectionActions(
          page,
          dependencies.listProfileFacts?.() ?? [],
          classifiedRepeatedActions(taskId, page)
        ).length > 0) {
          await service.runUntilPauseInternal(taskId, page);
          return;
        }
      }

      let current = page;
      type ResolvedField = { field: FormField; decision: FieldResolution };
      const pendingDecisions: ResolvedField[] = [];
      const seenFieldIds = new Set<string>();
      const failedFieldIds = new Set<string>();

      const resolvePass = async (
        fields: FormField[],
        phase: "deterministic" | "semantic"
      ): Promise<ResolvedField[]> => (await Promise.all(fields.map(async (field) => ({
        field,
        decision: await dependencies.resolveField(taskId, field, phase)
      })))).map(({ field, decision }) => {
        if (decision.assessment) fieldCoverageStore.record(taskId, decision.assessment);
        const approvedReview = contentReviews.get(taskId);
        if (approvedReview?.status === "approved" && approvedReview.fieldId === field.id) {
          return {
            field,
            decision: {
              ...decision,
              status: "verified" as const,
              value: approvedReview.draft,
              requiresContentReview: false
            }
          };
        }
        if (decision.status === "verified"
          && field.required
          && !hasUserValue(field.currentValue)
          && !hasUserValue(decision.value)) {
          return {
            field,
            decision: {
              ...decision,
              status: "needs_question" as const,
              question: decision.question ?? `请补充“${field.label}”`
            }
          };
        }
        return { field, decision };
      });

      const applyVerified = async (
        resolved: ResolvedField[],
        displayPhase: ApplicationDisplayPhase
      ): Promise<boolean> => {
        const fillable = resolved.filter(({ decision }) =>
          decision.status === "verified" && !decision.requiresContentReview
        );
        if (fillable.length === 0) return true;
        const state = actor.getSnapshot().value;
        if (state === "observing") sendApplicationEvent(actor, { type: "READY_TO_FILL" });
        else if (state !== "filling") throw new Error(`状态 ${String(state)} 不能开始填写`);

        const recordSuccessfulApply = async (
          field: FormField,
          operation: StartOperationInput,
          result: ExecutionResult
        ): Promise<boolean> => {
          fieldCoverageStore.markFilled(taskId, field.id, result.warnings ?? []);
          if (operation.retryKey !== undefined
            && operation.retryKey === auditableOperationKey(taskId, field)) {
            fullPageAuditFor(taskId).recordApplied(operation.retryKey, result.actualValue, field.id);
            auditOperationsFor(taskId).set(operation.retryKey, operation);
          }
          persist(actor, current);
          const audited = await runFullPageAudit(taskId, actor, current, "field_applied");
          current = audited.snapshot;
          if (audited.challenged) return false;
          audited.mismatches.forEach((mismatch) => failedFieldIds.add(mismatch.fieldId));
          return audited.mismatches.length === 0 && runIsCurrent(taskId, runGeneration, actor);
        };

        for (let index = 0; index < fillable.length; index += 1) {
          if (!runIsCurrent(taskId, runGeneration, actor)) return false;
          const { field, decision } = fillable[index]!;
          const observedField = current.fields.find((candidate) => candidate.id === field.id);
          if (hasUserValue(observedField?.currentValue)) continue;
          if (observedField === undefined
            || observedField.type !== field.type
            || observedField.label !== field.label
            || observedField.semanticHint !== field.semanticHint) {
            persist(actor, current);
            await service.runUntilPauseInternal(taskId, current);
            return false;
          }
          const semanticPath = decision.fieldPath ?? observedField.semanticHint;
          const operationSemanticPath = semanticPath !== undefined
            && observedField.semanticHint?.startsWith(`${semanticPath}.`)
            ? observedField.semanticHint
            : semanticPath;
          const entryIndex = semanticPath === undefined ? undefined : entryIndexFromSemanticPath(semanticPath);
          const searchValues = observedField.interactionMode === "search"
            && semanticPath !== undefined
            ? conservativeSearchValues(String(decision.value ?? ""), semanticPath)
            : undefined;
          let operationSnapshot = current;
          let operationField = observedField;
          const commandType = fieldCommandType(observedField);
          let result: ExecutionResult;
          const fillOperation = operationInput(
            taskId,
            commandType === "click_intermediate" ? "navigate" : commandType,
            field.id,
            displayCategory(field),
            index + 1,
            fillable.length,
            commandType === "upload" ? 60_000 : 15_000,
            displayPhase,
            operationSemanticPath === undefined || (commandType !== "fill" && commandType !== "select")
              ? undefined
              : fieldOperationKey({
                  taskId,
                  semanticPath: operationSemanticPath,
                  controlRole: field.interactionMode ?? field.type,
                  fieldLabel: field.label,
                  ...(field.sectionHint === undefined ? {} : { sectionHint: field.sectionHint }),
                  ...(entryIndex === undefined ? {} : { entryIndex })
                })
          );
          try {
            result = await progress.runWithPolicy(
              fillOperation,
              async (attempt) => {
                const attemptValue = searchValues?.[attempt - 1] ?? (searchValues === undefined
                  ? decision.value
                  : undefined);
                if (searchValues !== undefined && attemptValue === undefined) {
                  throw new Error("conservative_search_value_unavailable");
                }
                const attemptCommand = fieldCommand(
                  operationSnapshot,
                  operationField,
                  attemptValue,
                  nextExecutionEpoch(taskId),
                  dependencies.approve,
                  dependencies.resolveFileId
                );
                progress.setCurrentAction(taskId, {
                  action: attemptCommand.type === "select"
                    ? `正在选择：${field.label}`
                    : attemptCommand.type === "upload"
                      ? `正在上传：${field.label}`
                      : `正在填写：${field.label}`,
                  fieldId: operationField.id,
                  attempt,
                  maxAttempts: 2
                });
                const attemptResult = await executeWithSignedEpoch(attemptCommand);
                if (operationField.interactionMode === "search"
                  && attemptResult.status !== "applied"
                  && !isTerminalSafetyBlock(attemptResult)) {
                  throw new Error(attemptResult.errors[0] ?? "search_selection_failed");
                }
                return attemptResult;
              },
              {
                finalFailureMode: displayPhase === "semantic_fill" ? "defer" : "pause",
                canRetry: async () => {
                  if (searchValues !== undefined && searchValues[1] === undefined) return false;
                  retryReadbacks.add(taskId);
                  try {
                    if (!runIsLive(taskId, runGeneration, actor)) return false;
                    await invalidateExecution(taskId);
                    if (!runIsLive(taskId, runGeneration, actor)) return false;
                    const observedSnapshot = await dependencies.browser.observe(taskId);
                    if (!runIsLive(taskId, runGeneration, actor)) return false;
                    const observed = await prepareObservedSnapshot(taskId, actor, observedSnapshot);
                    if (observed === undefined || !runIsLive(taskId, runGeneration, actor)) return false;
                    const candidate = searchValues === undefined
                      ? observed.fields.find((candidate) => candidate.id === field.id)
                      : findSemanticField(observed, field, semanticPath!);
                    const retryAllowed = searchValues === undefined
                      ? observed.id === current.id && sameStructure(current, observed)
                      : samePageContext(current, observed);
                    if (!retryAllowed || candidate === undefined) {
                      return false;
                    }
                    const failedSearchValue = searchValues?.[0];
                    const retainsFailedSearchValue = failedSearchValue !== undefined
                      && String(candidate.currentValue ?? "").trim() === failedSearchValue.trim();
                    if (hasUserValue(candidate.currentValue) && !retainsFailedSearchValue) {
                      return false;
                    }
                    operationSnapshot = observed;
                    operationField = candidate;
                    return true;
                  } finally {
                    retryReadbacks.delete(taskId);
                  }
                }
              }
            );
          } catch (error) {
            if (isCancellation(error) || progress.snapshot(taskId).status === "paused") return false;
            if (displayPhase === "semantic_fill") {
              fieldCoverageStore.markFailed(
                taskId,
                field.id,
                error instanceof Error ? error.message : "field_execution_failed"
              );
              failedFieldIds.add(field.id);
              persist(actor, current);
              continue;
            }
            throw error;
          }
          if (!runIsCurrent(taskId, runGeneration, actor)) return false;
          const preparedResultSnapshot = await prepareObservedSnapshot(taskId, actor, result.snapshot);
          if (preparedResultSnapshot === undefined) return false;
          current = preparedResultSnapshot;
          if (isPackReadbackRegression(result)
            && await quarantineActivePack(taskId, actor, "unsafe mapping", result.snapshot)) return false;
          const approvedReview = contentReviews.get(taskId);
          if (result.status === "applied"
            && approvedReview?.status === "approved"
            && approvedReview.fieldId === field.id) {
            contentReviews.delete(taskId);
          }
          if (result.status !== "applied") {
            if (isTerminalSafetyBlock(result)) {
              pauseAfterExecutionFailure(actor, fillOperation, result);
              persist(actor, current);
              return false;
            }
            if (commandType === "fill" || commandType === "select") {
              await invalidateExecution(taskId);
              if (!runIsCurrent(taskId, runGeneration, actor)) return false;
              const observedSnapshot = await dependencies.browser.observe(taskId);
              if (!runIsCurrent(taskId, runGeneration, actor)) return false;
              const observed = await prepareObservedSnapshot(taskId, actor, observedSnapshot);
              if (observed === undefined || !runIsCurrent(taskId, runGeneration, actor)) return false;
              const retryField = observed.fields.find((candidate) => candidate.id === field.id);
              if (sameStructure(current, observed)
                && retryField !== undefined
                && !hasUserValue(retryField.currentValue)) {
                const [retryResolution] = await resolvePass([retryField], "semantic");
                if (!runIsCurrent(taskId, runGeneration, actor)) return false;
                if (retryResolution?.decision.status === "verified"
                  && !retryResolution.decision.requiresContentReview) {
                  const retryCommandType = fieldCommandType(retryField);
                  if (retryCommandType === "fill" || retryCommandType === "select") {
                    try {
                      result = await progress.runWithPolicy(
                        fillOperation,
                        (attempt) => {
                          const retryCommand = fieldCommand(
                            observed,
                            retryField,
                            retryResolution.decision.value,
                            nextExecutionEpoch(taskId),
                            dependencies.approve,
                            dependencies.resolveFileId
                          );
                          progress.setCurrentAction(taskId, {
                            action: retryCommand.type === "select"
                              ? `正在选择：${retryField.label}`
                              : `正在填写：${retryField.label}`,
                            fieldId: retryField.id,
                            attempt,
                            maxAttempts: 2
                          });
                          return executeWithSignedEpoch(retryCommand);
                        },
                        {
                          finalFailureMode: displayPhase === "semantic_fill" ? "defer" : "pause"
                        }
                      );
                    } catch (error) {
                      if (isCancellation(error) || progress.snapshot(taskId).status === "paused") return false;
                      if (displayPhase === "semantic_fill") {
                        fieldCoverageStore.markFailed(
                          taskId,
                          field.id,
                          error instanceof Error ? error.message : "field_execution_failed"
                        );
                        failedFieldIds.add(field.id);
                        persist(actor, current);
                        continue;
                      }
                      throw error;
                    }
                    if (!runIsCurrent(taskId, runGeneration, actor)) return false;
                    const preparedRetrySnapshot = await prepareObservedSnapshot(taskId, actor, result.snapshot);
                    if (preparedRetrySnapshot === undefined) return false;
                    current = preparedRetrySnapshot;
                    if (isPackReadbackRegression(result)
                      && await quarantineActivePack(taskId, actor, "unsafe mapping", result.snapshot)) return false;
                    if (result.status === "applied") {
                      if (!await recordSuccessfulApply(field, fillOperation, result)) return false;
                      continue;
                    }
                    if (isTerminalSafetyBlock(result)) {
                      pauseAfterExecutionFailure(actor, fillOperation, result);
                      persist(actor, current);
                      return false;
                    }
                  }
                }
              }
            }
            progress.recordFailure(
              fillOperation,
              result.status === "blocked" ? "READBACK_MISMATCH" : "PAGE_ERROR",
              "defer"
            );
            fieldCoverageStore.markFailed(taskId, field.id, result.errors[0] ?? "field_execution_failed");
            failedFieldIds.add(field.id);
            persist(actor, current);
            continue;
          }
          if (!await recordSuccessfulApply(field, fillOperation, result)) return false;
        }
        return true;
      };

      const auditBoundary = async (reason: FullPageAuditReason): Promise<boolean> => {
        const audited = await runFullPageAudit(taskId, actor, current, reason);
        current = audited.snapshot;
        if (audited.challenged) return false;
        audited.mismatches.forEach((mismatch) => failedFieldIds.add(mismatch.fieldId));
        return audited.mismatches.length === 0 && runIsCurrent(taskId, runGeneration, actor);
      };

      const deterministicFields = current.fields.filter((field) =>
        !hasUserValue(field.currentValue) && !isLegalAcknowledgementField(field));
      deterministicFields.forEach((field) => seenFieldIds.add(field.id));
      progress.setPhase(taskId, "deterministic_fill", "running");
      const deterministic = await resolvePass(deterministicFields, "deterministic");
      if (!runIsCurrent(taskId, runGeneration, actor)) return;
      if (!await applyVerified(deterministic, "deterministic_fill")) return;
      progress.setPhase(taskId, "deterministic_fill", "completed");
      pendingDecisions.push(...deterministic.filter(({ field, decision }) =>
        decision.status !== "verified" || decision.requiresContentReview || failedFieldIds.has(field.id)
      ));

      let semanticIds = new Set(deterministic
        .filter(({ decision }) => decision.status === "deferred")
        .map(({ field }) => field.id));
      let semanticStarted = false;
      for (let semanticRound = 0; semanticRound < 2; semanticRound += 1) {
        const semanticFields = current.fields.filter((field) =>
          !hasUserValue(field.currentValue)
          && !isLegalAcknowledgementField(field)
          && (semanticIds.has(field.id) || !seenFieldIds.has(field.id))
        );
        if (semanticFields.length === 0) break;
        if (!semanticStarted) {
          if (!await auditBoundary("phase_boundary")) return;
          progress.setPhase(taskId, "semantic_fill", "running");
          semanticStarted = true;
        }
        semanticFields.forEach((field) => seenFieldIds.add(field.id));
        const semantic = await resolvePass(semanticFields, "semantic");
        if (!runIsCurrent(taskId, runGeneration, actor)) return;
        if (!await applyVerified(semantic, "semantic_fill")) return;
        pendingDecisions.push(...semantic.filter(({ field, decision }) =>
          decision.status !== "verified" || decision.requiresContentReview || failedFieldIds.has(field.id)
        ));
        semanticIds = new Set(semantic
          .filter(({ decision }) => decision.status === "deferred")
          .map(({ field }) => field.id));
      }
      progress.setPhase(taskId, "semantic_fill", semanticStarted ? "completed" : "skipped");
      if (semanticStarted && !await auditBoundary("phase_boundary")) return;

      const unresolved = pendingDecisions.filter(({ field, decision }) => {
        const observed = current.fields.find((candidate) => candidate.id === field.id);
        return !hasUserValue(observed?.currentValue) && decision.status !== "deferred";
      });
      const questionsByPath = new Map<string, ApplicationQuestion>();
      for (const { field, decision } of unresolved) {
        if (!field.required || (decision.status !== "needs_question" && !failedFieldIds.has(field.id))) continue;
        const fieldPath = decision.fieldPath ?? field.semanticHint ?? field.id;
        if (questionsByPath.has(fieldPath)) continue;
        questionsByPath.set(fieldPath, {
          id: field.id,
          fieldId: field.id,
          fieldPath,
          label: field.label,
          text: decision.question ?? "请补充：" + field.label,
          pageText: field.label,
          interpretation: "系统已识别该字段，但尚无可安全填写的已确认资料",
          missingInformation: decision.question ?? `缺少“${field.label}”的本次投递答案`,
          scope: "application",
          inputType: questionInputType(field.type),
          options: field.options,
          required: field.required
        });
      }
      const questions = [...questionsByPath.values()];
      if (questions.length > 0) {
        sendApplicationEvent(actor, { type: "QUESTIONS_REQUIRED", questions });
        persist(actor, current);
        return;
      }
      if (unresolved.some(({ decision }) => decision.status === "blocked")) {
        sendApplicationEvent(actor, { type: "FAIL", errors: ["field_resolution_blocked"] });
        persist(actor, current);
        return;
      }

      const reviewDecision = unresolved.find(({ decision }) => decision.requiresContentReview);
      if (reviewDecision) {
        contentReviews.set(taskId, {
          id: randomUUID(),
          taskId,
          fieldId: reviewDecision.field.id,
          fieldLabel: reviewDecision.field.label,
          original: reviewDecision.decision.contentReview?.original ?? String(reviewDecision.decision.value ?? ""),
          draft: String(reviewDecision.decision.value ?? ""),
          reasons: reviewDecision.decision.contentReview?.reasons ?? ["该内容需要你确认后才能填写。"],
          evidence: reviewDecision.decision.contentReview?.evidence ?? [],
          unsupportedClaims: reviewDecision.decision.contentReview?.unsupportedClaims ?? [],
          status: reviewDecision.decision.contentReview?.status ?? "needs_review"
        });
        sendApplicationEvent(actor, { type: "CONTENT_REVIEW_REQUIRED" });
        persist(actor, current);
        return;
      }

      const legalReviewFields = current.fields.filter((field) =>
        isLegalAcknowledgementField(field) && !hasUserValue(field.currentValue));
      if (legalReviewFields.length > 0) {
        if (!await auditBoundary("final_review")) return;
        enterFinalReview(taskId);
        sendApplicationEvent(actor, { type: "REVIEW_REACHED" });
        persist(actor, current);
        return;
      }

      const currentState = actor.getSnapshot().value;
      if (currentState === "observing") sendApplicationEvent(actor, { type: "READY_TO_FILL" });
      else if (currentState !== "filling") throw new Error(`状态 ${String(currentState)} 不能完成填写`);
      const missingRequired = current.fields.filter((field) => field.required && !hasUserValue(field.currentValue));
      if (missingRequired.length > 0) {
        progress.setPhase(taskId, "readback_validation", "failed");
        sendApplicationEvent(actor, {
          type: "FAIL",
          errors: missingRequired.map((field) => `required_fields_empty:${field.label}`)
        });
        persist(actor, current);
        return;
      }
      sendApplicationEvent(actor, { type: "PAGE_FILLED" });
      persist(actor, current);
      progress.setPhase(taskId, "readback_validation", "running");
      progress.setCurrentAction(taskId, { action: "正在校验页面填写结果", maxAttempts: 2 });
      const validation = progress.startOperation(
        operationInput(taskId, "validate", "page", "页面状态", pendingDecisions.length || 1, pendingDecisions.length || 1, 10_000)
      );
      if (current.errors.length > 0) {
        progress.failOperation(taskId, validation.generation, "VALIDATION_FAILED");
        progress.setPhase(taskId, "readback_validation", "failed");
        sendApplicationEvent(actor, { type: "PAGE_INVALID", errors: current.errors });
        persist(actor, current);
        return;
      }
      progress.completeOperation(taskId, validation.generation);
      progress.setPhase(taskId, "readback_validation", "completed");
      sendApplicationEvent(actor, { type: "PAGE_VALID" });
      persist(actor, current);

      const repeatedSectionActionIds = new Set(
        classifiedRepeatedActions(taskId, current).map((action) => action.actionId)
      );
      const intermediate = current.actions.find((action) =>
        (action.class === "intermediate_navigation" || action.class === "intermediate_save")
        && !repeatedSectionActionIds.has(action.id));
      if (!intermediate) {
        if (current.actions.some((action) => action.class === "terminal_submit")) {
          if (!await auditBoundary("final_review")) return;
          enterFinalReview(taskId);
          sendApplicationEvent(actor, { type: "REVIEW_REACHED" });
          persist(actor, current);
          return;
        }
        sendApplicationEvent(actor, { type: "FAIL", errors: ["intermediate_action_not_found"] });
        persist(actor, current);
        return;
      }
      const executionEpoch = nextExecutionEpoch(taskId);
      const approval = dependencies.approve({
        taskId,
        snapshotId: current.id,
        targetId: intermediate.id,
        operation: "click_intermediate",
        nodeRef: intermediate.nodeRef,
        executionEpoch
      }, current);
      let result: ExecutionResult;
      const navigationOperation = operationInput(
        taskId,
        "navigate",
        intermediate.id,
        "页面状态",
        1,
        1,
        30_000
      );
      try {
        result = await progress.runWithPolicy(
          navigationOperation,
          () => executeWithSignedEpoch({
            type: "click_intermediate",
            taskId,
            snapshotId: current.id,
            actionId: intermediate.id,
            nodeRef: intermediate.nodeRef,
            executionEpoch,
            approval
          })
        );
      } catch (error) {
        if (isCancellation(error) || progress.snapshot(taskId).status === "paused") return;
        throw error;
      }
      if (!runIsCurrent(taskId, runGeneration, actor)) return;
      const nextPage = await prepareObservedSnapshot(taskId, actor, result.snapshot);
      if (nextPage === undefined) return;
      if (isPackReadbackRegression(result)
        && await quarantineActivePack(taskId, actor, "unsafe mapping", result.snapshot)) return;
      if (result.status !== "applied") {
        pauseAfterExecutionFailure(actor, navigationOperation, result);
        persist(actor, nextPage);
        return;
      }
      if (!hasObservablePageProgress(current, nextPage)) {
        sendApplicationEvent(actor, { type: "FAIL", errors: ["intermediate_no_progress"] });
        persist(actor, nextPage);
        return;
      }
      if (nextPage.stage === "review" || nextPage.stage === "success") {
        enterFinalReview(taskId);
        sendApplicationEvent(actor, { type: "REVIEW_REACHED" });
        persist(actor, nextPage);
        return;
      }
      sendApplicationEvent(actor, { type: "PAGE_NAVIGATED" });
      persist(actor, nextPage);
      await service.runUntilPauseInternal(taskId, nextPage);
    },

    async requestIntermediateClick(taskId: string, _actionId: string): Promise<void> {
      const state = requireActor(taskId).getSnapshot();
      if (state.value === "review_locked") throw new Error("review_locked");
      throw new Error(`状态 ${String(state.value)} 不允许直接请求中间点击`);
    },

    async handleActivity(activity: WorkerActivity): Promise<void> {
      const actor = requireActor(activity.taskId);
      dependencies.taskEvents?.emitProgress(activity.taskId, {
        type: "browser_activity",
        activity: toApplicationActivity(activity)
      });
      if (actor.getSnapshot().value === "awaiting_challenge") return;
      if (activity.type === "user_activity") {
        const currentPage = latestSnapshots.get(activity.taskId);
        if (actor.getSnapshot().value === "observing"
          && currentPage !== undefined
          && !applicationFormsReached.has(activity.taskId)
          && !isApplicationFormReady(currentPage)) return;
        invalidateRun(activity.taskId);
        if (latestSnapshots.has(activity.taskId)) {
          progress.handleUserActivity(activity.taskId, activity.fieldId);
        }
        return;
      }
      if (activity.type === "worker_disconnected") {
        invalidateRun(activity.taskId);
        progress.pause(activity.taskId, "worker_disconnected");
        return;
      }
      if (activity.type === "page_unstable") {
        const currentPage = latestSnapshots.get(activity.taskId);
        const machineState = actor.getSnapshot().value;
        if (machineState === "observing"
          && currentPage !== undefined
          && !applicationFormsReached.has(activity.taskId)
          && !isApplicationFormReady(currentPage)) return;
        if (!progress.snapshot(activity.taskId).busy && !retryReadbacks.has(activity.taskId)) return;
        invalidateRun(activity.taskId);
        progress.pause(activity.taskId, "page_unstable");
        return;
      }
      if (activity.type !== "page_stable") return;
      const existing = stableActivities.get(activity.taskId);
      if (existing) return existing;
      const handling = (async () => {
        const observedSnapshot = await dependencies.browser.observe(activity.taskId);
        const wasAwaitingLogin = actor.getSnapshot().value === "awaiting_login";
        if (wasAwaitingLogin && observedSnapshot.stage !== "login") {
          sendApplicationEvent(actor, { type: "RESUME" });
        }
        const observed = await prepareObservedSnapshot(activity.taskId, actor, observedSnapshot);
        if (observed === undefined) return;
        latestSnapshots.set(activity.taskId, observed);
        const machineState = actor.getSnapshot().value;
        if (wasAwaitingLogin) {
          if (observed.stage === "login") {
            persist(actor, observed);
            return;
          }
          progress.resumeIfCheckpointMatches(activity.taskId, true);
          persist(actor, observed);
          await service.runUntilPause(activity.taskId, observed);
          return;
        }
        if (!applicationFormsReached.has(activity.taskId)) {
          persist(actor, observed);
          await service.runUntilPause(activity.taskId, observed);
          return;
        }
        const progressSnapshot = progress.snapshot(activity.taskId);
        if (progressSnapshot.status === "paused"
          && !progressSnapshot.recovery.includes("manual_done")) return;
        const checkpoint = dependencies.checkpoints.latest(activity.taskId);
        const stalledFieldId = progressSnapshot.stalledFieldId;
        const stalledField = stalledFieldId === undefined
          ? undefined
          : observed.fields.find((field) => field.id === stalledFieldId);
        const manualReadbackPassed = stalledField === undefined
          ? checkpoint !== undefined && (
              matchesCheckpointStructure(observed, checkpoint)
              || isSameApplicationPath(observed.url, checkpoint.url)
            )
          : hasUserValue(stalledField.currentValue) && observed.errors.length === 0;
        if (!progress.resumeIfCheckpointMatches(activity.taskId, manualReadbackPassed)) return;
        persist(actor, observed);
        await service.runUntilPause(activity.taskId, observed);
      })().finally(() => {
        if (stableActivities.get(activity.taskId) === handling) stableActivities.delete(activity.taskId);
      });
      stableActivities.set(activity.taskId, handling);
      return handling;
    },

    async retryCurrent(taskId: string): Promise<void> {
      const actor = requireActor(taskId);
      if (!progress.snapshot(taskId).recovery.includes("retry_current")) throw new Error("recovery_not_allowed");
      const newlyReserved = reserveBrowserTask(taskId);
      try {
        await invalidateExecution(taskId);
        const observedSnapshot = await dependencies.browser.observe(taskId);
        let observed = await prepareObservedSnapshot(taskId, actor, observedSnapshot);
        if (observed === undefined) return;
        const checkpoint = dependencies.checkpoints.latest(taskId);
        const failedObservation = progress.snapshot(taskId).lastResult?.operation.kind === "observe"
          && progress.snapshot(taskId).lastResult?.operation.errorCode === "PAGE_ERROR";
        let reopenedCheckpoint = false;
        if (!failedObservation
          && checkpoint !== undefined
          && !matchesCheckpointStructure(observed, checkpoint)
          && isBrowserStartupPage(observed)
          && dependencies.browser.open !== undefined) {
          await dependencies.browser.open(taskId, checkpoint.url);
          const reopenedSnapshot = await dependencies.browser.observe(taskId);
          const reopened = await prepareObservedSnapshot(taskId, actor, reopenedSnapshot);
          if (reopened === undefined) return;
          observed = reopened;
          reopenedCheckpoint = true;
        }
        const checkpointMatches = checkpoint !== undefined && (
          matchesCheckpointStructure(observed, checkpoint)
          || reopenedCheckpoint && (observed.stage === "login" || isSameApplicationPath(observed.url, checkpoint.url))
        );
        if (!progress.resumeIfCheckpointMatches(taskId, failedObservation || checkpointMatches)) {
          throw new Error("checkpoint_mismatch");
        }
        await service.runUntilPause(taskId, observed);
      } catch (error) {
        if (newlyReserved) releaseBrowserTask(taskId);
        throw error;
      }
    },

    async manualDone(taskId: string): Promise<void> {
      requireActor(taskId);
      if (!progress.snapshot(taskId).recovery.includes("manual_done")) throw new Error("recovery_not_allowed");
      await invalidateExecution(taskId);
      const actor = requireActor(taskId);
      const observedSnapshot = await dependencies.browser.observe(taskId);
      const observed = await prepareObservedSnapshot(taskId, actor, observedSnapshot);
      if (observed === undefined) return;
      const fieldId = progress.snapshot(taskId).stalledFieldId;
      const field = observed.fields.find((candidate) => candidate.id === fieldId);
      if (!field || !hasUserValue(field.currentValue) || observed.errors.length > 0) {
        throw new Error("manual_readback_failed");
      }
      progress.resumeIfCheckpointMatches(taskId, true);
      await service.runUntilPause(taskId, observed);
    }
  };

  challengeCoordinator = createChallengeCoordinator({
    invalidateExecution,
    persist,
    observe: (taskId) => dependencies.browser.observe(taskId),
    continueWithSnapshot: (taskId, snapshot) => service.runUntilPauseInternal(taskId, snapshot)
  });

  dependencies.browser.onActivity?.((activity) => {
    void service.handleActivity(activity).catch((error: unknown) => {
      if (isIgnorableActivityError(activity.taskId, error, actors, progress)) return;
      try {
        invalidateRun(activity.taskId);
        progress.recordFailure(
          operationInput(activity.taskId, "observe", "page", "页面状态", 1, 1, 10_000),
          "PAGE_ERROR"
        );
      } catch {
        // Activity callbacks must never surface rejected promises into the Worker IPC boundary.
      }
    });
  });
  return service;
}

function isTerminalSafetyBlock(result: ExecutionResult): boolean {
  return result.status === "blocked" && result.errors.some((error) =>
    error === "unsafe_intermediate_action"
    || error === "unsafe_intermediate_navigation"
    || error === "terminal_submission_blocked"
  );
}

function isPackReadbackRegression(result: ExecutionResult): boolean {
  return result.errors.some((error) =>
    error === "controlled_value_reverted" || error === "node_role_changed"
  );
}

function questionInputType(type: FormField["type"]): ApplicationQuestion["inputType"] {
  if (type === "radio") return "select";
  if (type === "file") return "text";
  return type;
}

function withDerivedEntrySemantics(snapshot: FormSnapshot, profileFacts: readonly ProfileFact[]): FormSnapshot {
  const catalogued = annotateDjiFields(snapshot);
  return {
    ...catalogued,
    fields: deriveEntrySemanticHints(catalogued.fields, {
      experienceIndexesBySection: {
        work: compatibleExperienceIndexes(profileFacts, "work"),
        internship: compatibleExperienceIndexes(profileFacts, "internship"),
        work_combined: compatibleExperienceIndexes(profileFacts, "work_combined")
      }
    })
  };
}

function restoreActor(
  actor: ApplicationActor,
  state: ApplicationStateValue,
  questions: ApplicationQuestion[],
  challenge: FormSnapshot["challenge"]
): void {
  if (state === "awaiting_login") {
    sendApplicationEvent(actor, { type: "LOGIN_REQUIRED" });
  } else if (state === "needs_questions") {
    sendApplicationEvent(actor, { type: "QUESTIONS_REQUIRED", questions });
  } else if (state === "awaiting_content_review") {
    sendApplicationEvent(actor, { type: "CONTENT_REVIEW_REQUIRED" });
  } else if (state === "awaiting_challenge") {
    if (challenge === undefined) throw new Error("challenge_checkpoint_invalid");
    sendApplicationEvent(actor, { type: "CHALLENGE_DETECTED", challenge });
  } else if (state === "awaiting_adapter_review") {
    sendApplicationEvent(actor, { type: "ADAPTER_REVIEW_REQUIRED" });
  } else if (state === "review_locked") {
    sendApplicationEvent(actor, { type: "REVIEW_REACHED" });
  } else if (state === "failed") {
    sendApplicationEvent(actor, { type: "FAIL", errors: ["restored_failure"] });
  } else if (state === "cancelled") {
    sendApplicationEvent(actor, { type: "CANCEL" });
  }
  // created, observing, and transient browser-mutation states recover as observing.
  // No browser command is replayed until a fresh observation is requested.
}

function toApiState(state: ApplicationStateValue): ApplicationTaskState {
  const states: Record<ApplicationStateValue, ApplicationTaskState> = {
    created: "created",
    observing: "observing_page",
    awaiting_login: "waiting_for_login",
    needs_questions: "needs_questions",
    awaiting_content_review: "awaiting_content_review",
    awaiting_challenge: "awaiting_challenge",
    awaiting_adapter_review: "awaiting_adapter_review",
    filling: "filling",
    validating: "validating",
    navigating: "navigating",
    review_locked: "review_locked",
    cancelled: "cancelled",
    failed: "failed"
  };
  return states[state];
}

function matchesCheckpoint(
  snapshot: FormSnapshot,
  checkpoint: ApplicationCheckpoint
): boolean {
  return snapshot.url === checkpoint.url
    && snapshot.stage === checkpoint.stage
    && snapshot.id === checkpoint.snapshotId
    && snapshot.fields.map((field) => field.id).join("\u0000") === checkpoint.fieldIds.join("\u0000");
}

function matchesCheckpointStructure(snapshot: FormSnapshot, checkpoint: ApplicationCheckpoint): boolean {
  return snapshot.url === checkpoint.url
    && snapshot.stage === checkpoint.stage
    && snapshot.fields.map((field) => field.id).join("\u0000") === checkpoint.fieldIds.join("\u0000");
}

function isBrowserStartupPage(snapshot: FormSnapshot): boolean {
  if (snapshot.fields.length > 0 || snapshot.actions.length > 0) return false;
  try {
    return new Set(["about:", "chrome:", "edge:"]).has(new URL(snapshot.url).protocol);
  } catch {
    return false;
  }
}

function isSameApplicationPath(currentUrl: string, checkpointUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const checkpoint = new URL(checkpointUrl);
    if (current.origin !== checkpoint.origin) return false;
    const routePath = (url: URL): string => url.hash.startsWith("#/") ? url.hash.slice(1).split("?")[0]! : url.pathname;
    const currentPath = routePath(current);
    const checkpointPath = routePath(checkpoint);
    if (currentPath === checkpointPath) return true;
    const applicationPath = /^(?:apply|application|applications|candidate|resume)$/iu;
    const currentSegments = currentPath.split("/").filter(Boolean);
    const checkpointSegments = checkpointPath.split("/").filter(Boolean);
    const markerIndex = checkpointSegments.findIndex((segment) => applicationPath.test(segment));
    return markerIndex >= 0
      && currentSegments.length > markerIndex
      && currentSegments.slice(0, markerIndex + 1).join("/") === checkpointSegments.slice(0, markerIndex + 1).join("/");
  } catch {
    return false;
  }
}

function sameStructure(left: FormSnapshot, right: FormSnapshot): boolean {
  return left.url === right.url
    && left.stage === right.stage
    && left.fields.map((field) => field.id).join("\u0000") === right.fields.map((field) => field.id).join("\u0000");
}

function samePageContext(left: FormSnapshot, right: FormSnapshot): boolean {
  return left.url === right.url && left.stage === right.stage;
}

function findSemanticField(snapshot: FormSnapshot, original: FormField, semanticPath: string): FormField | undefined {
  const controlRole = original.interactionMode ?? original.type;
  const candidates = snapshot.fields.filter((candidate) =>
    candidate.semanticHint === semanticPath
    && candidate.sectionHint === original.sectionHint
    && (candidate.interactionMode ?? candidate.type) === controlRole
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function entryIndexFromSemanticPath(semanticPath: string): number | undefined {
  const match = /^[^[.]+\[(\d+)\]/u.exec(semanticPath);
  return match === null ? undefined : Number(match[1]);
}

function auditableOperationKey(taskId: string, field: FormField): string | undefined {
  if (field.semanticHint === undefined) return undefined;
  const entryIndex = entryIndexFromSemanticPath(field.semanticHint);
  return fieldOperationKey({
    taskId,
    semanticPath: field.semanticHint,
    controlRole: field.interactionMode ?? field.type,
    fieldLabel: field.label,
    ...(field.sectionHint === undefined ? {} : { sectionHint: field.sectionHint }),
    ...(entryIndex === undefined ? {} : { entryIndex })
  });
}

function conservativeSearchValues(value: string, semanticPath: string): readonly [string, string?] {
  const normalized = value.normalize("NFKC").trim();
  const fallback = /\.major$/u.test(semanticPath) ? normalized.replace(/专业$/u, "") : normalized;
  return fallback !== "" && fallback !== normalized ? [normalized, fallback] : [normalized];
}

function hasObservablePageProgress(before: FormSnapshot, after: FormSnapshot): boolean {
  return before.url !== after.url
    || before.stage !== after.stage
    || before.title !== after.title
    || before.fields.map((field) => field.id).join("\u0000") !== after.fields.map((field) => field.id).join("\u0000")
    || before.actions.map((action) => action.id).join("\u0000") !== after.actions.map((action) => action.id).join("\u0000")
    || before.errors.join("\u0000") !== after.errors.join("\u0000");
}

function hasUserValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false;
}

function isResumeUploadField(field: FormField): boolean {
  if (field.type !== "file") return false;
  return /resume|cv|简历/u.test(`${field.semanticHint ?? ""} ${field.label}`);
}

function isApplicationFormReady(snapshot: FormSnapshot): boolean {
  if (snapshot.stage !== "application_form") return false;
  if (snapshot.fields.some((field) => isResumeUploadField(field) || field.required)) return true;
  return snapshot.actions.some((action) =>
    action.class === "intermediate_navigation"
    || action.class === "intermediate_save"
    || action.class === "terminal_submit"
  );
}

function displayCategory(field: FormField): ApplicationDisplayCategory {
  const value = `${field.semanticHint ?? ""} ${field.label}`.toLocaleLowerCase();
  if (/mail|phone|mobile|邮箱|电话|手机/u.test(value)) return "联系方式";
  if (/education|school|degree|教育|学校|学历/u.test(value)) return "教育经历";
  if (/work|company|employment|工作|公司|实习/u.test(value)) return "工作经历";
  if (/project|项目/u.test(value)) return "项目经历";
  if (/file|resume|附件|简历/u.test(value)) return "附件";
  return "当前字段";
}

function operationInput(
  taskId: string,
  kind: StartOperationInput["kind"],
  fieldId: string,
  category: ApplicationDisplayCategory,
  current: number,
  total: number,
  timeoutMs: number,
  displayPhase?: ApplicationDisplayPhase,
  retryKey?: string
): StartOperationInput {
  return {
    taskId,
    kind,
    fieldId,
    displayCategory: category,
    current,
    total,
    timeoutMs,
    ...(displayPhase === undefined ? {} : { displayPhase }),
    ...(retryKey === undefined ? {} : { retryKey })
  };
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error
    && (error.message === "operation_cancelled_by_user" || error.message === "operation_cancelled");
}

function isIgnorableActivityError(
  taskId: string,
  error: unknown,
  actors: Map<string, ApplicationActor>,
  progress: ReturnType<typeof createApplicationProgressCoordinator>
): boolean {
  if (isCancellation(error)) return true;
  const actor = actors.get(taskId);
  if (!actor) return true;
  const state = actor.getSnapshot().value;
  return state === "cancelled"
    || state === "review_locked"
    || (progress.snapshot(taskId).status === "paused" && error instanceof Error && error.message === "task_paused");
}

function toApplicationActivity(activity: WorkerActivity): {
  kind: "page_changed" | "page_stable" | "user_activity" | "worker_connected" | "worker_disconnected";
  fieldId?: string;
  displayCategory: ApplicationDisplayCategory;
} {
  const kind = activity.type === "page_unstable" ? "page_changed" : activity.type;
  return {
    kind,
    ...(activity.type === "user_activity" ? { fieldId: activity.fieldId } : {}),
    displayCategory: activity.type === "worker_connected" || activity.type === "worker_disconnected"
      ? "浏览器状态"
      : activity.type === "user_activity" ? "当前字段" : "页面状态"
  };
}

function fieldCommand(
  snapshot: FormSnapshot,
  field: FormField,
  value: unknown,
  executionEpoch: number,
  approve: ApplicationServiceDependencies["approve"],
  resolveFileId?: ApplicationServiceDependencies["resolveFileId"]
): ExecutableCommand {
  const operation = fieldCommandType(field);
  const approval = approve({
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    targetId: field.id,
    operation,
    nodeRef: field.nodeRef,
    executionEpoch
  }, snapshot);
  if (operation === "select") {
    return {
      type: "select",
      taskId: snapshot.taskId,
      snapshotId: snapshot.id,
      fieldId: field.id,
      value: String(value ?? ""),
      nodeRef: field.nodeRef,
      executionEpoch,
      approval
    };
  }
  if (operation === "upload") {
    const fileId = resolveFileId?.(snapshot.taskId, field);
    if (!fileId) throw new Error("resume_file_unavailable");
    return {
      type: "upload",
      taskId: snapshot.taskId,
      snapshotId: snapshot.id,
      fieldId: field.id,
      fileId,
      nodeRef: field.nodeRef,
      executionEpoch,
      approval
    };
  }
  return {
    type: "fill",
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    fieldId: field.id,
    value,
    nodeRef: field.nodeRef,
    executionEpoch,
    approval
  };
}

function fieldCommandType(field: FormField): ExecutableCommand["type"] {
  return field.type === "file"
    ? "upload"
    : field.type === "select" || field.type === "radio" ? "select" : "fill";
}

function isLegalAcknowledgementField(field: FormField): boolean {
  if (field.type !== "checkbox" && field.type !== "radio") return false;
  return /privacy\s*(?:policy|notice)|terms\s*(?:and|of)\s*(?:conditions|use)|\bi\s*(?:certify|declare|acknowledge)\b|真实性|隐私政策|隐私声明|用户协议|法律声明|本人承诺.*(?:真实|准确)/iu.test(field.label);
}
