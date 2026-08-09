import { randomUUID } from "node:crypto";
import type {
  ApplicationContentReview,
  ApplicationFieldAssessment,
  ApplicationFieldCoverage,
  ApplicationQuestion,
  ApplicationDisplayPhase,
  ApplicationDisplayCategory,
  ApplicationTaskProgress,
  ApplicationTaskState,
  ExecutableCommand,
  FormField,
  FormSnapshot,
  WorkerActivity,
  WorkerResponse
} from "@resume/contracts";
import { createActor } from "xstate";
import {
  applicationMachine,
  sendApplicationEvent,
  type ApplicationActor,
  type ApplicationStateValue
} from "./application-machine.js";
import type {
  ApplicationCheckpoint,
  CheckpointRepository,
  StoredContentReview
} from "./checkpoint-repository.js";
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
  state(taskId: string): ReturnType<ApplicationActor["getSnapshot"]>;
  requiresRecovery(taskId: string): boolean;
  openBrowser(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  resumeWithProfile(taskId: string): Promise<void>;
  answerQuestions(taskId: string, answers: Record<string, unknown>): Promise<void>;
  contentReview(taskId: string): ContentReview | undefined;
  fieldCoverage(taskId: string): ApplicationFieldCoverage | undefined;
  approveReview(taskId: string, reviewId: string, editedValue?: string): Promise<void>;
  rejectReview(taskId: string, reviewId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  dispose(taskId: string): void;
  runUntilPause(taskId: string, initialSnapshot?: FormSnapshot): Promise<void>;
  requestIntermediateClick(taskId: string, actionId: string): Promise<void>;
  progress(taskId: string): ApplicationProgressSnapshot;
  recoveryCommands(taskId: string): ApplicationRecoveryCommand[];
  handleActivity(activity: WorkerActivity): Promise<void>;
  retryCurrent(taskId: string): Promise<void>;
  manualDone(taskId: string): Promise<void>;
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

interface ApplicationServiceDependencies {
  checkpoints: CheckpointRepository;
  taskEvents?: Pick<TaskEventBus, "emit" | "emitProgress">;
  browser: BrowserPort;
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
  }, snapshot: FormSnapshot): string;
  applyAnswers?: (
    taskId: string,
    answers: Record<string, unknown>,
    fields: FormField[],
    questions?: ApplicationQuestion[]
  ) => Promise<void> | void;
  validateContentReview?: (review: ContentReview, editedValue: string) => string[];
  resolveFileId?: (taskId: string, field: FormField) => string | undefined;
}

export interface StartApplicationInput {
  taskId: string;
  applicationUrl: string;
}

export function createApplicationService(dependencies: ApplicationServiceDependencies): ApplicationService {
  const actors = new Map<string, ApplicationActor>();
  let activeBrowserTaskId: string | undefined;

  const releaseTerminalBrowserTask = (): string | undefined => {
    if (activeBrowserTaskId === undefined) return undefined;
    const actor = actors.get(activeBrowserTaskId);
    if (actor && ["cancelled", "failed", "review_locked"].includes(actor.getSnapshot().value)) {
      activeBrowserTaskId = undefined;
    }
    return activeBrowserTaskId;
  };
  const reserveBrowserTask = (taskId: string): boolean => {
    if (releaseTerminalBrowserTask() !== undefined && activeBrowserTaskId !== taskId) {
      throw new Error("browser_task_in_use");
    }
    const newlyReserved = activeBrowserTaskId !== taskId;
    activeBrowserTaskId = taskId;
    return newlyReserved;
  };
  const latestSnapshots = new Map<string, FormSnapshot>();
  const contentReviews = new Map<string, ContentReview>();
  const recoveryCheckpoints = new Map<string, ApplicationCheckpoint>();
  const lastPublishedStates = new Map<string, ApplicationTaskState>();
  const stableActivities = new Map<string, Promise<void>>();
  const runGenerations = new Map<string, number>();
  const executionEpochs = new Map<string, number>();
  const fieldCoverageStore = createFieldCoverageStore();
  const progress = createApplicationProgressCoordinator({
    emit(taskId, event) {
      if (event.type !== "state_changed") dependencies.taskEvents?.emitProgress(taskId, event);
    },
    persist(taskId, snapshot) {
      dependencies.checkpoints.saveProgress(taskId, snapshot);
    }
  });

  const requireActor = (taskId: string): ApplicationActor => {
    const existing = actors.get(taskId);
    if (existing) return existing;
    const checkpoint = dependencies.checkpoints.latest(taskId);
    if (!checkpoint) throw new Error("application_task_not_found");
    const actor = createActor(applicationMachine, {
      input: { taskId, applicationUrl: checkpoint.url }
    }).start();
    sendApplicationEvent(actor, { type: "START" });
    restoreActor(actor, checkpoint.state, checkpoint.questions);
    actors.set(taskId, actor);
    if (["created", "observing", "filling", "validating", "navigating"].includes(checkpoint.state)) {
      recoveryCheckpoints.set(taskId, checkpoint);
    }
    if (checkpoint.snapshot) latestSnapshots.set(taskId, checkpoint.snapshot);
    if (checkpoint.contentReview) contentReviews.set(taskId, checkpoint.contentReview);
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
        : { contentReview: contentReviews.get(machineState.context.taskId)! })
    });
    const state = toApiState(machineState.value as ApplicationStateValue);
    if (lastPublishedStates.get(machineState.context.taskId) !== state) {
      dependencies.taskEvents?.emit(machineState.context.taskId, state);
      lastPublishedStates.set(machineState.context.taskId, state);
    }
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

  const invalidateRunGeneration = (taskId: string): number => {
    const generation = (runGenerations.get(taskId) ?? 0) + 1;
    runGenerations.set(taskId, generation);
    return generation;
  };

  const invalidateRun = (taskId: string): number => {
    const generation = invalidateRunGeneration(taskId);
    void invalidateExecution(taskId).catch(() => undefined);
    return generation;
  };

  const executeWithFreshEpoch = (command: ExecutableCommand): Promise<ExecutionResult> =>
    dependencies.browser.execute(command, nextExecutionEpoch(command.taskId));

  const runIsLive = (taskId: string, generation: number, actor: ApplicationActor): boolean =>
    runGenerations.get(taskId) === generation
    && actor.getSnapshot().value !== "cancelled";

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

  const service: ApplicationService = {
    start(input: StartApplicationInput): void {
      if (actors.has(input.taskId)) throw new Error(`投递任务已存在：${input.taskId}`);
      const actor = createActor(applicationMachine, { input }).start();
      sendApplicationEvent(actor, { type: "START" });
      actors.set(input.taskId, actor);
      const storedProgress = dependencies.checkpoints.latestProgress(input.taskId);
      if (storedProgress) progress.restore(input.taskId, storedProgress);
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
        if (newlyReserved && activeBrowserTaskId === taskId) activeBrowserTaskId = undefined;
        throw error;
      }
    },

    async resume(taskId: string): Promise<void> {
      const newlyReserved = reserveBrowserTask(taskId);
      try {
        const existingActor = actors.get(taskId);
        if (existingActor) {
          const recoveryCheckpoint = recoveryCheckpoints.get(taskId);
          if (recoveryCheckpoint) {
            const observed = await dependencies.browser.observe(taskId);
            if (observed.stage !== "login" && !matchesCheckpoint(observed, recoveryCheckpoint)) {
              actors.delete(taskId);
              recoveryCheckpoints.delete(taskId);
              throw new Error("checkpoint_mismatch");
            }
            if (observed.stage === "login") {
              sendApplicationEvent(existingActor, { type: "LOGIN_REQUIRED" });
            }
            latestSnapshots.set(taskId, observed);
            recoveryCheckpoints.delete(taskId);
            persist(existingActor, observed);
            return;
          }
          if (existingActor.getSnapshot().value !== "awaiting_login") {
            throw new Error(`投递任务已在当前进程恢复：${taskId}`);
          }
          const observed = await dependencies.browser.observe(taskId);
          latestSnapshots.set(taskId, observed);
          if (observed.stage !== "login") {
            sendApplicationEvent(existingActor, { type: "RESUME" });
          }
          persist(existingActor, observed);
          return;
        }
        const checkpoint = dependencies.checkpoints.latest(taskId);
        if (!checkpoint) throw new Error(`投递任务检查点不存在：${taskId}`);
        const actor = createActor(applicationMachine, {
          input: { taskId, applicationUrl: checkpoint.url }
        }).start();
        sendApplicationEvent(actor, { type: "START" });
        restoreActor(actor, checkpoint.state, checkpoint.questions);
        actors.set(taskId, actor);

        const observed = await dependencies.browser.observe(taskId);
        if (checkpoint.state !== "awaiting_login" && !matchesCheckpoint(observed, checkpoint)) {
          actors.delete(taskId);
          throw new Error("checkpoint_mismatch");
        }
        if (checkpoint.state === "awaiting_login" && actor.getSnapshot().value === "awaiting_login") {
          sendApplicationEvent(actor, { type: "RESUME" });
        }
        latestSnapshots.set(taskId, observed);
        persist(actor, observed);
      } catch (error) {
        if (newlyReserved && activeBrowserTaskId === taskId) activeBrowserTaskId = undefined;
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
        sendApplicationEvent(actor, { type: "PROFILE_UPDATED" });
        latestSnapshots.set(taskId, observed);
        persist(actor, observed);
        await service.runUntilPause(taskId, observed);
      } catch (error) {
        if (newlyReserved && activeBrowserTaskId === taskId) activeBrowserTaskId = undefined;
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
      await invalidateExecution(taskId).catch(() => undefined);
      await dependencies.browser.releaseTask?.(taskId);
      sendApplicationEvent(actor, { type: "CANCEL" });
      if (activeBrowserTaskId === taskId) activeBrowserTaskId = undefined;
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
      recoveryCheckpoints.delete(taskId);
      lastPublishedStates.delete(taskId);
      stableActivities.delete(taskId);
      runGenerations.delete(taskId);
      executionEpochs.delete(taskId);
      if (activeBrowserTaskId === taskId) activeBrowserTaskId = undefined;
    },

    async runUntilPause(taskId: string, initialSnapshot?: FormSnapshot): Promise<void> {
      const actor = requireActor(taskId);
      if (actor.getSnapshot().value === "review_locked") return;
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
      page = withDerivedEntrySemantics(page);
      if (!runIsCurrent(taskId, runGeneration, actor)) return;
      latestSnapshots.set(taskId, page);
      persist(actor, page);

      if (page.stage === "review" || page.stage === "success") {
        sendApplicationEvent(actor, { type: "REVIEW_REACHED" });
        persist(actor, page);
        return;
      }
      if (page.stage === "login") {
        if (actor.getSnapshot().value !== "awaiting_login") {
          sendApplicationEvent(actor, { type: "LOGIN_REQUIRED" });
        }
        persist(actor, page);
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
          dependencies.approve,
          dependencies.resolveFileId
        );
        const uploadOperation = operationInput(taskId, "upload", resumeField.id, "附件", 1, 1, 60_000);
        const result = await progress.runWithPolicy(
          uploadOperation,
          () => executeWithFreshEpoch(command)
        );
        if (!runIsCurrent(taskId, runGeneration, actor)) return;
        if (result.status !== "applied") {
          pauseAfterExecutionFailure(actor, uploadOperation, result);
          persist(actor, result.snapshot);
          return;
        }
        page = withDerivedEntrySemantics(result.snapshot);
        latestSnapshots.set(taskId, page);
        persist(actor, page);
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

        for (let index = 0; index < fillable.length; index += 1) {
          if (!runIsCurrent(taskId, runGeneration, actor)) return false;
          const { field, decision } = fillable[index]!;
          const observedField = current.fields.find((candidate) => candidate.id === field.id);
          if (hasUserValue(observedField?.currentValue)) continue;
          const command = fieldCommand(
            current,
            field,
            decision.value,
            dependencies.approve,
            dependencies.resolveFileId
          );
          let result: ExecutionResult;
          const fillOperation = operationInput(
            taskId,
            command.type === "click_intermediate" ? "navigate" : command.type,
            field.id,
            displayCategory(field),
            index + 1,
            fillable.length,
            command.type === "upload" ? 60_000 : 15_000,
            displayPhase
          );
          try {
            result = await progress.runWithPolicy(
              fillOperation,
              () => executeWithFreshEpoch(command),
              {
                canRetry: async () => {
                  if (!runIsLive(taskId, runGeneration, actor)) return false;
                  await invalidateExecution(taskId);
                  if (!runIsLive(taskId, runGeneration, actor)) return false;
                  const observed = await dependencies.browser.observe(taskId);
                  if (!runIsLive(taskId, runGeneration, actor)) return false;
                  latestSnapshots.set(taskId, observed);
                  const candidate = observed.fields.find((candidate) => candidate.id === field.id);
                  return observed.id === current.id
                    && sameStructure(current, observed)
                    && candidate !== undefined
                    && !hasUserValue(candidate.currentValue);
                }
              }
            );
          } catch (error) {
            if (isCancellation(error) || progress.snapshot(taskId).status === "paused") return false;
            throw error;
          }
          if (!runIsCurrent(taskId, runGeneration, actor)) return false;
          current = withDerivedEntrySemantics(result.snapshot);
          latestSnapshots.set(taskId, current);
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
            if (command.type === "fill" || command.type === "select") {
              await invalidateExecution(taskId);
              if (!runIsCurrent(taskId, runGeneration, actor)) return false;
              const observed = withDerivedEntrySemantics(await dependencies.browser.observe(taskId));
              if (!runIsCurrent(taskId, runGeneration, actor)) return false;
              latestSnapshots.set(taskId, observed);
              const retryField = observed.fields.find((candidate) => candidate.id === field.id);
              if (sameStructure(current, observed)
                && retryField !== undefined
                && !hasUserValue(retryField.currentValue)) {
                const [retryResolution] = await resolvePass([retryField], "semantic");
                if (!runIsCurrent(taskId, runGeneration, actor)) return false;
                if (retryResolution?.decision.status === "verified"
                  && !retryResolution.decision.requiresContentReview) {
                  const retryCommand = fieldCommand(
                    observed,
                    retryField,
                    retryResolution.decision.value,
                    dependencies.approve,
                    dependencies.resolveFileId
                  );
                  if (retryCommand.type === "fill" || retryCommand.type === "select") {
                    try {
                      result = await progress.runWithPolicy(
                        fillOperation,
                        () => executeWithFreshEpoch(retryCommand)
                      );
                    } catch (error) {
                      if (isCancellation(error) || progress.snapshot(taskId).status === "paused") return false;
                      throw error;
                    }
                    if (!runIsCurrent(taskId, runGeneration, actor)) return false;
                    current = withDerivedEntrySemantics(result.snapshot);
                    latestSnapshots.set(taskId, current);
                    if (result.status === "applied") {
                      fieldCoverageStore.markFilled(taskId, field.id, result.warnings ?? []);
                      persist(actor, current);
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
          fieldCoverageStore.markFilled(taskId, field.id, result.warnings ?? []);
          persist(actor, current);
        }
        return true;
      };

      const deterministicFields = current.fields.filter((field) =>
        !hasUserValue(field.currentValue) && !isLegalAcknowledgementField(field));
      deterministicFields.forEach((field) => seenFieldIds.add(field.id));
      const deterministic = await resolvePass(deterministicFields, "deterministic");
      if (!runIsCurrent(taskId, runGeneration, actor)) return;
      if (!await applyVerified(deterministic, "deterministic_fill")) return;
      pendingDecisions.push(...deterministic.filter(({ field, decision }) =>
        decision.status !== "verified" || decision.requiresContentReview || failedFieldIds.has(field.id)
      ));

      let semanticIds = new Set(deterministic
        .filter(({ decision }) => decision.status === "deferred")
        .map(({ field }) => field.id));
      for (let semanticRound = 0; semanticRound < 2; semanticRound += 1) {
        const semanticFields = current.fields.filter((field) =>
          !hasUserValue(field.currentValue)
          && !isLegalAcknowledgementField(field)
          && (semanticIds.has(field.id) || !seenFieldIds.has(field.id))
        );
        if (semanticFields.length === 0) break;
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
        sendApplicationEvent(actor, { type: "REVIEW_REACHED" });
        persist(actor, current);
        return;
      }

      const currentState = actor.getSnapshot().value;
      if (currentState === "observing") sendApplicationEvent(actor, { type: "READY_TO_FILL" });
      else if (currentState !== "filling") throw new Error(`状态 ${String(currentState)} 不能完成填写`);
      const missingRequired = current.fields.filter((field) => field.required && !hasUserValue(field.currentValue));
      if (missingRequired.length > 0) {
        sendApplicationEvent(actor, {
          type: "FAIL",
          errors: missingRequired.map((field) => `required_fields_empty:${field.label}`)
        });
        persist(actor, current);
        return;
      }
      sendApplicationEvent(actor, { type: "PAGE_FILLED" });
      persist(actor, current);
      const validation = progress.startOperation(
        operationInput(taskId, "validate", "page", "页面状态", pendingDecisions.length || 1, pendingDecisions.length || 1, 10_000)
      );
      if (current.errors.length > 0) {
        progress.failOperation(taskId, validation.generation, "VALIDATION_FAILED");
        sendApplicationEvent(actor, { type: "PAGE_INVALID", errors: current.errors });
        persist(actor, current);
        return;
      }
      progress.completeOperation(taskId, validation.generation);
      sendApplicationEvent(actor, { type: "PAGE_VALID" });
      persist(actor, current);

      const intermediate = current.actions.find((action) =>
        action.class === "intermediate_navigation" || action.class === "intermediate_save");
      if (!intermediate) {
        if (current.actions.some((action) => action.class === "terminal_submit")) {
          sendApplicationEvent(actor, { type: "REVIEW_REACHED" });
          persist(actor, current);
          return;
        }
        sendApplicationEvent(actor, { type: "FAIL", errors: ["intermediate_action_not_found"] });
        persist(actor, current);
        return;
      }
      const approval = dependencies.approve({
        taskId,
        snapshotId: current.id,
        targetId: intermediate.id,
        operation: "click_intermediate"
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
          () => executeWithFreshEpoch({
            type: "click_intermediate",
            taskId,
            snapshotId: current.id,
            actionId: intermediate.id,
            approval
          })
        );
      } catch (error) {
        if (isCancellation(error) || progress.snapshot(taskId).status === "paused") return;
        throw error;
      }
      if (!runIsCurrent(taskId, runGeneration, actor)) return;
      const nextPage = withDerivedEntrySemantics(result.snapshot);
      latestSnapshots.set(taskId, nextPage);
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
        sendApplicationEvent(actor, { type: "REVIEW_REACHED" });
        persist(actor, nextPage);
        return;
      }
      sendApplicationEvent(actor, { type: "PAGE_NAVIGATED" });
      persist(actor, nextPage);
      await service.runUntilPause(taskId, nextPage);
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
      if (activity.type === "user_activity") {
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
        invalidateRun(activity.taskId);
        progress.pause(activity.taskId, "page_unstable");
        return;
      }
      if (activity.type !== "page_stable") return;
      const existing = stableActivities.get(activity.taskId);
      if (existing) return existing;
      const handling = (async () => {
        const observed = await dependencies.browser.observe(activity.taskId);
        latestSnapshots.set(activity.taskId, observed);
        const machineState = actor.getSnapshot().value;
        if (machineState === "awaiting_login") {
          if (observed.stage === "login") {
            persist(actor, observed);
            return;
          }
          sendApplicationEvent(actor, { type: "RESUME" });
          progress.resumeIfCheckpointMatches(activity.taskId, true);
          persist(actor, observed);
          await service.runUntilPause(activity.taskId, observed);
          return;
        }
        const checkpoint = dependencies.checkpoints.latest(activity.taskId);
        const stalledFieldId = progress.snapshot(activity.taskId).stalledFieldId;
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
      requireActor(taskId);
      if (!progress.snapshot(taskId).recovery.includes("retry_current")) throw new Error("recovery_not_allowed");
      await invalidateExecution(taskId);
      const observed = await dependencies.browser.observe(taskId);
      latestSnapshots.set(taskId, observed);
      const checkpoint = dependencies.checkpoints.latest(taskId);
      const failedObservation = progress.snapshot(taskId).lastResult?.operation.kind === "observe"
        && progress.snapshot(taskId).lastResult?.operation.errorCode === "PAGE_ERROR";
      if (!progress.resumeIfCheckpointMatches(taskId,
        failedObservation || (checkpoint !== undefined && matchesCheckpointStructure(observed, checkpoint)))) {
        throw new Error("checkpoint_mismatch");
      }
      await service.runUntilPause(taskId, observed);
    },

    async manualDone(taskId: string): Promise<void> {
      requireActor(taskId);
      if (!progress.snapshot(taskId).recovery.includes("manual_done")) throw new Error("recovery_not_allowed");
      await invalidateExecution(taskId);
      const observed = await dependencies.browser.observe(taskId);
      latestSnapshots.set(taskId, observed);
      const fieldId = progress.snapshot(taskId).stalledFieldId;
      const field = observed.fields.find((candidate) => candidate.id === fieldId);
      if (!field || !hasUserValue(field.currentValue) || observed.errors.length > 0) {
        throw new Error("manual_readback_failed");
      }
      progress.resumeIfCheckpointMatches(taskId, true);
      await service.runUntilPause(taskId, observed);
    }
  };

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

function questionInputType(type: FormField["type"]): ApplicationQuestion["inputType"] {
  if (type === "radio") return "select";
  if (type === "file") return "text";
  return type;
}

function withDerivedEntrySemantics(snapshot: FormSnapshot): FormSnapshot {
  const catalogued = annotateDjiFields(snapshot);
  return { ...catalogued, fields: deriveEntrySemanticHints(catalogued.fields) };
}

function restoreActor(
  actor: ApplicationActor,
  state: ApplicationStateValue,
  questions: ApplicationQuestion[]
): void {
  if (state === "awaiting_login") {
    sendApplicationEvent(actor, { type: "LOGIN_REQUIRED" });
  } else if (state === "needs_questions") {
    sendApplicationEvent(actor, { type: "QUESTIONS_REQUIRED", questions });
  } else if (state === "awaiting_content_review") {
    sendApplicationEvent(actor, { type: "CONTENT_REVIEW_REQUIRED" });
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
  displayPhase?: ApplicationDisplayPhase
): StartOperationInput {
  return {
    taskId,
    kind,
    fieldId,
    displayCategory: category,
    current,
    total,
    timeoutMs,
    ...(displayPhase === undefined ? {} : { displayPhase })
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
  approve: ApplicationServiceDependencies["approve"],
  resolveFileId?: ApplicationServiceDependencies["resolveFileId"]
): ExecutableCommand {
  const operation = field.type === "file"
    ? "upload"
    : field.type === "select" || field.type === "radio" ? "select" : "fill";
  const approval = approve({
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    targetId: field.id,
    operation
  }, snapshot);
  if (operation === "select") {
    return {
      type: "select",
      taskId: snapshot.taskId,
      snapshotId: snapshot.id,
      fieldId: field.id,
      value: String(value ?? ""),
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
      approval
    };
  }
  return {
    type: "fill",
    taskId: snapshot.taskId,
    snapshotId: snapshot.id,
    fieldId: field.id,
    value,
    approval
  };
}

function isLegalAcknowledgementField(field: FormField): boolean {
  if (field.type !== "checkbox" && field.type !== "radio") return false;
  return /privacy\s*(?:policy|notice)|terms\s*(?:and|of)\s*(?:conditions|use)|\bi\s*(?:certify|declare|acknowledge)\b|真实性|隐私政策|隐私声明|用户协议|法律声明|本人承诺.*(?:真实|准确)/iu.test(field.label);
}
