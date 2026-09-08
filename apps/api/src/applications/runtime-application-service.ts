import type {
  AgentRunResult,
  AdapterReviewSummary,
  ApplicationDisplayCategory,
  ApplicationFieldCoverage,
  ApplicationQuestion,
  FormSnapshot,
  RuntimeHumanInterrupt,
  RuntimeHumanResume,
  WorkerActivity
} from "@resume/contracts";
import type { JsonValue } from "@resume/contracts";
import { applyCertifiedHintPack, type HintPackRegistry } from "@resume/form-semantics";
import type { AgentRuntime } from "../agent/runtime/agent-runtime.js";
import {
  createRuntimeApplicationStateStore,
  restoreFieldCoverage,
  type RuntimeApplicationState,
  type RuntimeApplicationPendingInterrupt,
  type RuntimeApplicationStateStore
} from "../agent/runtime/application-state-store.js";
import type { ApplicationStateValue, ApplicationContext } from "./application-machine.js";
import type { ApplicationProgressSnapshot } from "./application-progress.js";
import type { ApplicationService, ApplicationServiceSnapshot, ContentReview, StartApplicationInput } from "./application-service.js";
import type { ApplicationTaskRepository, StoredApplicationTask } from "./application-task-repository.js";
import type { GraphApplicationReviewRepository } from "./graph-application-review-repository.js";
import { BrowserOwnershipLease } from "../browser/browser-ownership-lease.js";
import type { TaskEventBus } from "./task-events.js";
import { createFieldCoverageStore, type FieldCoverageStore } from "./field-coverage.js";

const APPLICATION_GOAL = "请打开申请页面，自动填写申请表并完成提交前复核，最终提交必须由人工确认。";
const TERMINAL_VALUES = new Set<ApplicationServiceSnapshot["value"]>(["review_locked", "cancelled", "failed"]);

export interface RuntimeApplicationBrowserPort {
  open(taskId: string, url: string): Promise<unknown>;
  observe?(taskId: string): Promise<FormSnapshot>;
  invalidateExecution?(taskId: string, executionEpoch: number): Promise<void>;
  /** Pass a trusted, already-captured snapshot across the service boundary once. */
  seedObservation?(taskId: string, snapshot: FormSnapshot): void;
  releaseTask?(taskId: string): Promise<void>;
}

interface RuntimeAdapterReviewServicePort {
  prepare(taskId: string, snapshot: FormSnapshot): Promise<AdapterReviewSummary>;
  retire(packId: string, version: string, reason: string): void;
}

export interface RuntimeApplicationServiceDependencies {
  taskRepository: ApplicationTaskRepository;
  runtime: Pick<AgentRuntime, "start" | "resume" | "recover" | "cancel" | "inspect">;
  browser: RuntimeApplicationBrowserPort;
  stateStore?: RuntimeApplicationStateStore;
  fieldCoverage?: FieldCoverageStore;
  browserOwnershipLease?: BrowserOwnershipLease;
  taskEvents?: Pick<TaskEventBus, "emit" | "emitProgress">;
  profileRevision(): number;
  reviewRepository?: GraphApplicationReviewRepository;
  validateContentReview?: (review: ContentReview, draft: string) => string[];
  hintPackRegistry?: HintPackRegistry;
  adapterReviewService?: RuntimeAdapterReviewServicePort;
  applyAnswers?: (
    taskId: string,
    answers: Record<string, unknown>,
    questions?: ApplicationQuestion[]
  ) => Promise<void> | void;
}

/**
 * HTTP-facing facade for Runtime-owned application tasks. It deliberately
 * contains no browser write logic and no alternate orchestrator; every run,
 * resume and cancellation is delegated to AgentRuntime.
 */
export function createRuntimeApplicationService(
  dependencies: RuntimeApplicationServiceDependencies
): ApplicationService {
  const stateStore = dependencies.stateStore ?? createRuntimeApplicationStateStore();
  const coverageStore = dependencies.fieldCoverage ?? createFieldCoverageStore();
  const lease = dependencies.browserOwnershipLease ?? new BrowserOwnershipLease();
  const runIds = new Map<string, string>();
  const runtimeInterrupts = new Map<string, RuntimeHumanInterrupt>();
  const snapshots = new Map<string, ApplicationServiceSnapshot>();
  const fallbackValues = new Map<string, ApplicationServiceSnapshot["value"]>();
  const activeRuns = new Map<string, Promise<void>>();
  const adapterReviews = new Map<string, AdapterReviewSummary>();
  const adapterReviewEpochs = new Map<string, number>();

  const requireTask = (taskId: string): StoredApplicationTask => {
    const task = dependencies.taskRepository.get(taskId);
    if (task === undefined) throw new Error("application_task_not_found");
    if (task.orchestrator !== "agent-runtime") throw new Error("application_task_not_runtime_owned");
    return task;
  };

  const prepareObservedSnapshot = async (taskId: string, observed: FormSnapshot): Promise<FormSnapshot | undefined> => {
    if (observed.stage !== "application_form"
      || dependencies.hintPackRegistry === undefined
      || dependencies.adapterReviewService === undefined) {
      return observed;
    }
    const resolution = dependencies.hintPackRegistry.resolve(observed);
    if (resolution.kind === "certified") return applyCertifiedHintPack(observed, resolution.pack);
    // Declarative Skills own sites that do not use a certified ATS hint pack.
    // Adapter review is reserved for a known pack whose live fingerprint drifted.
    if (resolution.reason === "no_certified_pack") return observed;
    if (resolution.reason === "fingerprint_mismatch") {
      for (const pack of resolution.mismatchedPacks) {
        dependencies.adapterReviewService.retire(pack.packId, pack.version, "superseded mapping");
      }
    }
    const nextEpoch = (adapterReviewEpochs.get(taskId) ?? 0) + 1;
    adapterReviewEpochs.set(taskId, nextEpoch);
    await dependencies.browser.invalidateExecution?.(taskId, nextEpoch);
    adapterReviews.set(taskId, await dependencies.adapterReviewService.prepare(taskId, observed));
    publish(taskId, {
      value: "awaiting_adapter_review",
      context: { taskId, applicationUrl: observed.url, questions: [], errors: [] }
    });
    return undefined;
  };

  const storedForTask = (taskId: string): RuntimeApplicationState | undefined => {
    const matches = stateStore.persistence().list().filter((state) => state.taskId === taskId);
    return matches.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).at(-1);
  };

  const runIdFor = (taskId: string): string | undefined => {
    const cached = runIds.get(taskId);
    if (cached !== undefined) return cached;
    const stored = storedForTask(taskId);
    if (stored === undefined) return undefined;
    runIds.set(taskId, stored.runId);
    return stored.runId;
  };

  const publish = (taskId: string, snapshot: ApplicationServiceSnapshot): ApplicationServiceSnapshot => {
    snapshots.set(taskId, snapshot);
    fallbackValues.delete(taskId);
    const task = dependencies.taskRepository.get(taskId);
    if (task !== undefined) dependencies.taskEvents?.emit(taskId, toApiState(snapshot.value));
    if (TERMINAL_VALUES.has(snapshot.value)) releaseIfOwned(lease, taskId);
    return snapshot;
  };

  const rememberResult = async (taskId: string, result: AgentRunResult): Promise<void> => {
    runIds.set(taskId, result.runId);
    if (result.pendingInterrupt !== undefined) runtimeInterrupts.set(result.runId, result.pendingInterrupt);
    else runtimeInterrupts.delete(result.runId);
    const task = requireTask(taskId);
    const existing = await stateStore.get(result.runId);
    const application = existing ?? {
      version: "1.1.0" as const,
      runId: result.runId,
      taskId,
      applicationUrl: task.applicationUrl,
      executionEpoch: 0,
      plannedCommandIds: [],
      completedCommandIds: [],
      retryCount: 0,
      finalReviewLocked: false,
      updatedAt: new Date().toISOString()
    };
    const pending = result.pendingInterrupt === undefined
      ? undefined
      : runtimeInterruptToApplicationInterrupt(result.pendingInterrupt, application);
    const { pendingInterrupt: _previousPendingInterrupt, ...applicationWithoutPending } = application;
    await stateStore.save({
      ...applicationWithoutPending,
      taskId,
      applicationUrl: task.applicationUrl,
      finalReviewLocked: application.finalReviewLocked || result.status === "completed" || result.pendingInterrupt?.reason === "final_submit",
      ...(pending === undefined ? {} : { pendingInterrupt: pending }),
      updatedAt: new Date().toISOString()
    });
    publish(taskId, snapshotFromRuntime(task, result, application, pending));
  };

  const inspectPending = async (taskId: string): Promise<{ runId: string; interrupt: RuntimeHumanInterrupt }> => {
    const runId = runIdFor(taskId);
    if (runId === undefined) throw new Error("agent_run_not_found");
    const cached = runtimeInterrupts.get(runId);
    if (cached !== undefined) return { runId, interrupt: cached };
    const inspected = await dependencies.runtime.inspect(runId);
    const interrupt = inspected.checkpoint.pendingInterrupt;
    if (inspected.status !== "interrupted" || interrupt === undefined) throw new Error("agent_resume_not_pending");
    runtimeInterrupts.set(runId, interrupt);
    return { runId, interrupt };
  };

  const resumeWith = async (
    taskId: string,
    action: RuntimeHumanResume["action"],
    values: Record<string, unknown> = {}
  ): Promise<void> => {
    const { runId, interrupt } = await inspectPending(taskId);
    const result = await dependencies.runtime.resume(runId, {
      interruptId: interrupt.interruptId,
      action,
      values: values as RuntimeHumanResume["values"]
    });
    await rememberResult(taskId, result);
  };

  const service: ApplicationService = {
    start(input: StartApplicationInput): void {
      if (dependencies.taskRepository.get(input.taskId) === undefined) {
        dependencies.taskRepository.create({
          id: input.taskId,
          applicationUrl: input.applicationUrl
        });
      }
      requireTask(input.taskId);
      if (runIdFor(input.taskId) !== undefined || snapshots.has(input.taskId)) {
        throw new Error("application_task_already_started");
      }
      fallbackValues.set(input.taskId, "observing");
    },

    activeBrowserTaskId(): string | undefined {
      const owner = lease.current();
      return owner?.ownerKind === "application" ? owner.ownerId : undefined;
    },

    state(taskId: string): ApplicationServiceSnapshot {
      const task = requireTask(taskId);
      const cached = snapshots.get(taskId);
      if (cached !== undefined) return cached;
      const stored = storedForTask(taskId);
      if (stored !== undefined) {
        const pending = stored.pendingInterrupt === undefined ? undefined : applicationInterruptToRuntime(stored.pendingInterrupt, stored);
        if (pending !== undefined) runtimeInterrupts.set(stored.runId, pending);
        runIds.set(taskId, stored.runId);
        const snapshot = snapshotFromStored(task, stored);
        snapshots.set(taskId, snapshot);
        return snapshot;
      }
      return {
        value: fallbackValues.get(taskId) ?? "created",
        context: { taskId, applicationUrl: task.applicationUrl, questions: [], errors: [] }
      };
    },

    requiresRecovery(taskId: string): boolean {
      requireTask(taskId);
      return false;
    },

    async openBrowser(taskId: string): Promise<void> {
      const task = requireTask(taskId);
      const owner = lease.current();
      const newlyReserved = owner?.ownerKind !== "application" || owner.ownerId !== taskId;
      try {
        lease.acquire({ ownerKind: "application", ownerId: taskId });
      } catch (error) {
        if (error instanceof Error && error.message === "browser_lease_in_use") throw new Error("browser_task_in_use");
        throw error;
      }
      try {
        await dependencies.browser.open(taskId, task.applicationUrl);
      } catch (error) {
        if (newlyReserved) releaseIfOwned(lease, taskId);
        throw error;
      }
    },

    async resume(taskId: string): Promise<void> {
      if (this.state(taskId).value === "awaiting_challenge") throw new Error("challenge_resume_not_allowed");
      await resumeWith(taskId, "confirm");
    },

    async resumeAfterChallenge(taskId: string): Promise<void> {
      if (this.state(taskId).value !== "awaiting_challenge") throw new Error("challenge_resume_not_pending");
      await resumeWith(taskId, "confirm");
    },

    async resumeAfterAdapterCertification(taskId: string): Promise<void> {
      if (this.state(taskId).value !== "awaiting_adapter_review") {
        throw new Error("adapter_review_resume_not_allowed");
      }
      if (dependencies.browser.observe === undefined) throw new Error("adapter_not_certified");
      const observed = await dependencies.browser.observe(taskId);
      const prepared = await prepareObservedSnapshot(taskId, observed);
      if (prepared === undefined) throw new Error("adapter_not_certified");
      adapterReviews.delete(taskId);
      snapshots.delete(taskId);
      fallbackValues.set(taskId, "observing");
      await this.runUntilPause(taskId, prepared);
    },

    async resumeWithProfile(taskId: string): Promise<void> {
      await resumeWith(taskId, "confirm");
    },

    async refreshFromProfile(): Promise<void> {
      for (const task of dependencies.taskRepository.list()) {
        if (task.orchestrator !== "agent-runtime") continue;
        if (this.state(task.id).value === "needs_questions") {
          try { await resumeWith(task.id, "confirm"); } catch { /* a later explicit command can retry */ }
        }
      }
    },

    async syncTaskFromProfile(taskId: string): Promise<void> {
      const task = requireTask(taskId);
      dependencies.taskRepository.markProfileSyncPending(taskId);
      try {
        await service.resumeWithProfile(taskId);
        dependencies.taskRepository.markProfileSyncSucceeded(taskId, dependencies.profileRevision());
      } catch (error) {
        dependencies.taskRepository.markProfileSyncFailed(taskId, "runtime_profile_sync_failed");
        throw error;
      }
      void task;
    },

    async answerQuestions(taskId: string, answers: Record<string, unknown>): Promise<void> {
      requireTask(taskId);
      const questions = this.state(taskId).context.questions;
      await dependencies.applyAnswers?.(taskId, answers, questions);
      await resumeWith(taskId, "correct", answers);
    },

    contentReview(taskId: string): ContentReview | undefined {
      requireTask(taskId);
      return dependencies.reviewRepository?.current(taskId);
    },

    adapterReview(taskId: string): AdapterReviewSummary | undefined {
      requireTask(taskId);
      return adapterReviews.get(taskId);
    },

    fieldCoverage(taskId: string): ApplicationFieldCoverage | undefined {
      requireTask(taskId);
      const current = coverageStore.snapshot(taskId);
      if (current !== undefined) return current;
      const stored = storedForTask(taskId);
      if (stored?.fieldCoverage === undefined) return undefined;
      coverageStore.restore(taskId, restoreFieldCoverage(stored.fieldCoverage));
      return coverageStore.snapshot(taskId);
    },

    async approveReview(taskId: string, reviewId: string, editedValue?: string): Promise<void> {
      const review = dependencies.reviewRepository?.find(taskId, reviewId);
      if (review === undefined || review.status !== "needs_review") throw new Error("content_review_mismatch");
      const draft = editedValue ?? review.draft;
      if (dependencies.validateContentReview?.(review, draft).length !== 0) throw new Error("content_review_unsupported_edit");
      if (dependencies.reviewRepository?.approve(taskId, reviewId, draft) === undefined) throw new Error("content_review_mismatch");
      await resumeWith(taskId, "approve", editedValue === undefined ? {} : { editedValue });
    },

    async rejectReview(taskId: string, reviewId: string): Promise<void> {
      const review = dependencies.reviewRepository?.find(taskId, reviewId);
      if (review === undefined) throw new Error("content_review_mismatch");
      await resumeWith(taskId, "reject");
      dependencies.reviewRepository?.remove(taskId, reviewId);
    },

    async cancel(taskId: string): Promise<void> {
      requireTask(taskId);
      const runId = runIdFor(taskId);
      if (runId === undefined) {
        fallbackValues.set(taskId, "cancelled");
        releaseIfOwned(lease, taskId);
        await dependencies.browser.releaseTask?.(taskId);
        return;
      }
      const result = await dependencies.runtime.cancel(runId);
      await rememberResult(taskId, result);
      await dependencies.browser.releaseTask?.(taskId).catch(() => undefined);
    },

    async dispose(taskId: string): Promise<void> {
      requireTask(taskId);
      const runId = runIdFor(taskId);
      if (runId !== undefined) await stateStore.delete(runId);
      runIds.delete(taskId);
      runtimeInterrupts.delete(runId ?? "");
      snapshots.delete(taskId);
      fallbackValues.delete(taskId);
      activeRuns.delete(taskId);
      coverageStore.dispose(taskId);
      adapterReviews.delete(taskId);
      adapterReviewEpochs.delete(taskId);
      releaseIfOwned(lease, taskId);
      await dependencies.browser.releaseTask?.(taskId).catch(() => undefined);
    },

    async runUntilPause(taskId: string, initialSnapshot?: FormSnapshot): Promise<void> {
      const active = activeRuns.get(taskId);
      if (active !== undefined) return active;
      const operation = (async () => {
        const task = requireTask(taskId);
        const owner = lease.current();
        if (owner === undefined && initialSnapshot !== undefined) {
          lease.acquire({ ownerKind: "application", ownerId: taskId });
        }
        lease.assertOwner({ ownerKind: "application", ownerId: taskId });
        let observed = initialSnapshot;
        if (observed === undefined && dependencies.browser.observe !== undefined) {
          try {
            observed = await dependencies.browser.observe(taskId);
          } catch {
            // The Runtime owns observation failure handling and records the
            // terminal state; this preflight must not become a second executor.
          }
        }
        if (observed !== undefined) {
          if (observed.taskId !== taskId) throw new Error("application_snapshot_task_mismatch");
          const prepared = await prepareObservedSnapshot(taskId, observed);
          if (prepared === undefined) return;
          dependencies.browser.seedObservation?.(taskId, prepared);
        }
        const runId = runIdFor(taskId);
        if (runId === undefined) {
          const result = await dependencies.runtime.start({
            goal: `${APPLICATION_GOAL} 目标申请页面：${task.applicationUrl}`,
            requestedBy: "application-service",
            contextRefs: [],
            autonomyLevel: "execute_with_approval",
            metadata: {
              applicationTaskId: task.id,
              applicationUrl: task.applicationUrl,
              profileRevision: dependencies.profileRevision()
            }
          });
          await rememberResult(taskId, result);
          return;
        }
        const inspected = await dependencies.runtime.inspect(runId);
        if (inspected.status === "running") {
          await rememberResult(taskId, await dependencies.runtime.recover(runId));
        } else if (inspected.status === "interrupted" && inspected.checkpoint.pendingInterrupt !== undefined) {
          runtimeInterrupts.set(runId, inspected.checkpoint.pendingInterrupt);
        } else {
          await rememberResult(taskId, {
            runId,
            status: inspected.status,
            ...(inspected.checkpoint.pendingInterrupt === undefined ? {} : { pendingInterrupt: inspected.checkpoint.pendingInterrupt }),
            ...(inspected.checkpoint.intentId === undefined ? {} : { intentId: inspected.checkpoint.intentId }),
            ...(inspected.checkpoint.planId === undefined ? {} : { planId: inspected.checkpoint.planId })
          });
        }
      })();
      activeRuns.set(taskId, operation);
      try { await operation; } finally {
        if (activeRuns.get(taskId) === operation) activeRuns.delete(taskId);
      }
    },

    async requestIntermediateClick(_taskId: string, _actionId: string): Promise<void> {
      throw new Error("intermediate_navigation_not_available");
    },

    progress(taskId: string): ApplicationProgressSnapshot {
      const state = this.state(taskId);
      const stored = storedForTask(taskId);
      return {
        status: ["created", "review_locked", "cancelled", "failed"].includes(state.value) ? "idle" : "running",
        busy: state.value === "filling" || state.value === "validating" || state.value === "navigating",
        generation: 0,
        retryCount: stored?.retryCount ?? 0,
        recovery: []
      };
    },

    recoveryCommands(taskId: string) {
      requireTask(taskId);
      return [];
    },

    async handleActivity(activity: WorkerActivity): Promise<void> {
      dependencies.taskEvents?.emitProgress(activity.taskId, {
        type: "browser_activity",
        activity: toApplicationActivity(activity)
      });
      if (activity.type === "page_stable" && this.state(activity.taskId).value === "observing") {
        await this.runUntilPause(activity.taskId);
      }
    },

    async retryCurrent(taskId: string): Promise<void> {
      requireTask(taskId);
      throw new Error("recovery_not_allowed");
    },

    async manualDone(taskId: string): Promise<void> {
      requireTask(taskId);
      throw new Error("recovery_not_allowed");
    }
  };

  return service;
}

function snapshotFromRuntime(
  task: StoredApplicationTask,
  result: AgentRunResult,
  stored: RuntimeApplicationState,
  pending?: ReturnType<typeof runtimeInterruptToApplicationInterrupt>
): ApplicationServiceSnapshot {
  const value: ApplicationStateValue = result.status === "interrupted" && result.pendingInterrupt !== undefined
    ? applicationValueForInterrupt(result.pendingInterrupt, stored)
    : result.status === "completed"
      ? "review_locked"
      : result.status === "cancelled"
        ? "cancelled"
        : result.status === "blocked" || result.status === "failed" || result.status === "expired"
          ? "failed"
          : "observing";
  return {
    value,
    context: contextFor(task, value, pending ?? (result.pendingInterrupt === undefined ? undefined : runtimeInterruptToApplicationInterrupt(result.pendingInterrupt)))
  };
}

function snapshotFromStored(task: StoredApplicationTask, stored: RuntimeApplicationState): ApplicationServiceSnapshot {
  const pending = stored.pendingInterrupt === undefined ? undefined : applicationInterruptToRuntime(stored.pendingInterrupt, stored);
  const value = stored.finalReviewLocked
    ? "review_locked"
    : stored.pendingInterrupt === undefined
      ? "observing"
      : applicationValueForInterrupt(pending!, stored);
  return { value, context: contextFor(task, value, stored.pendingInterrupt) };
}

function contextFor(
  task: StoredApplicationTask,
  value: ApplicationStateValue,
  pending?: { kind: string; reasonCode: string; questionIds?: string[] }
): ApplicationContext {
  const questionIds = pending?.questionIds ?? [];
  return {
    taskId: task.id,
    applicationUrl: task.applicationUrl,
    questions: questionIds.map((id) => questionFor(id)),
    errors: value === "failed" ? [pending?.reasonCode ?? "runtime_failed"] : [],
    ...(value === "awaiting_challenge" ? {
      challenge: {
        kind: /captcha/iu.test(pending?.reasonCode ?? "") ? "captcha" : /rate/iu.test(pending?.reasonCode ?? "") ? "rate_limited" : "risk_control",
        detectedAt: new Date().toISOString(),
        reasonCode: pending?.reasonCode ?? "challenge_detected"
      }
    } : {})
  };
}

function questionFor(id: string): ApplicationQuestion {
  const fieldId = id.startsWith("field:") ? id.slice("field:".length) : id;
  return {
    id,
    fieldId,
    ...(id.startsWith("field:") && fieldId.includes(".") ? { fieldPath: fieldId } : {}),
    text: "Provide a confirmed value for this field.",
    pageText: "The current page requires a confirmed value.",
    interpretation: "The value needs human confirmation before filling.",
    missingInformation: "No confirmed evidence is available for this field.",
    scope: "application",
    inputType: "text",
    options: [],
    required: true
  };
}

function applicationValueForInterrupt(
  interrupt: RuntimeHumanInterrupt,
  _stored: RuntimeApplicationState
): ApplicationStateValue {
  switch (interrupt.reason) {
    case "authentication": return "awaiting_login";
    case "captcha": return "awaiting_challenge";
    case "final_submit": return "review_locked";
    case "high_risk_action": return "awaiting_content_review";
    case "ambiguous_fact": return "needs_questions";
    default: return "failed";
  }
}

function runtimeInterruptToApplicationInterrupt(
  interrupt: RuntimeHumanInterrupt,
  stored?: RuntimeApplicationState
): RuntimeApplicationPendingInterrupt {
  const kind = interrupt.reason === "final_submit"
    ? "final_review"
    : interrupt.reason === "authentication"
      ? "login"
      : interrupt.reason === "captcha"
        ? "challenge"
        : interrupt.reason === "high_risk_action"
          ? "content_review"
          : interrupt.reason === "ambiguous_fact"
            ? "missing_fact"
            : "fact_conflict";
  const proposed = asObject(interrupt.proposedAction);
  const questionIds = Array.isArray(proposed?.questionIds)
    ? proposed.questionIds.filter((item): item is string => typeof item === "string").slice(0, 50)
    : [];
  const runId = stringFrom(proposed?.runId);
  const taskId = stringFrom(proposed?.taskId);
  const stepId = stringFrom(proposed?.stepId);
  const snapshotId = stringFrom(proposed?.snapshotId);
  const targetFingerprint = stringFrom(proposed?.targetFingerprint);
  const payloadHash = hashFrom(proposed?.payloadHash);
  const safetyStateRef = stringFrom(proposed?.safetyStateRef);
  const planRevision = positiveIntegerFrom(proposed?.planRevision);
  const executionEpoch = nonNegativeIntegerFrom(proposed?.executionEpoch);
  return {
    id: interrupt.interruptId,
    kind,
    reasonCode: interrupt.reason,
    questionIds,
    evidenceIds: [...interrupt.evidenceRefs].slice(0, 100),
    createdAt: createdAtForInterrupt(interrupt),
    ...(runId === undefined ? {} : { runId }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(stepId === undefined ? {} : { stepId }),
    ...(planRevision === undefined ? {} : { planRevision }),
    ...(executionEpoch === undefined ? {} : { executionEpoch }),
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(targetFingerprint === undefined ? {} : { targetFingerprint }),
    ...(payloadHash === undefined ? {} : { payloadHash }),
    ...(safetyStateRef === undefined ? {} : { safetyStateRef })
  };
}

function createdAtForInterrupt(interrupt: RuntimeHumanInterrupt): string {
  const expiresAt = Date.parse(interrupt.expiresAt);
  return Number.isFinite(expiresAt)
    ? new Date(expiresAt - 15 * 60_000).toISOString()
    : new Date().toISOString();
}

function applicationInterruptToRuntime(
  interrupt: RuntimeApplicationState["pendingInterrupt"],
  stored: RuntimeApplicationState
): RuntimeHumanInterrupt {
  if (interrupt === undefined) throw new Error("runtime_application_interrupt_missing");
  const reason: RuntimeHumanInterrupt["reason"] = interrupt.kind === "final_review"
    ? "final_submit"
    : interrupt.kind === "login"
      ? "authentication"
      : interrupt.kind === "challenge"
        ? "captcha"
        : interrupt.kind === "content_review"
        ? "high_risk_action"
        : "ambiguous_fact";
  const proposedAction: Record<string, JsonValue> = {
    kind: reason === "final_submit" ? "final_submit" : "application_review",
    runId: interrupt.runId ?? stored.runId,
    taskId: interrupt.taskId ?? stored.taskId,
    executionEpoch: interrupt.executionEpoch ?? stored.executionEpoch,
    safetyStateRef: interrupt.safetyStateRef
      ?? `application:${interrupt.taskId ?? stored.taskId}:epoch:${interrupt.executionEpoch ?? stored.executionEpoch}:snapshot:${interrupt.snapshotId ?? stored.snapshotId ?? "unknown"}`,
    questionIds: interrupt.questionIds
  };
  if (interrupt.stepId !== undefined) proposedAction.stepId = interrupt.stepId;
  if (interrupt.planRevision !== undefined) proposedAction.planRevision = interrupt.planRevision;
  if (interrupt.snapshotId !== undefined || stored.snapshotId !== undefined) {
    proposedAction.snapshotId = interrupt.snapshotId ?? stored.snapshotId!;
  }
  if (interrupt.targetFingerprint !== undefined) proposedAction.targetFingerprint = interrupt.targetFingerprint;
  if (interrupt.payloadHash !== undefined) proposedAction.payloadHash = interrupt.payloadHash;
  return {
    interruptId: interrupt.id,
    reason,
    summary: interrupt.reasonCode,
    evidenceRefs: interrupt.evidenceIds,
    proposedAction,
    expiresAt: new Date(Date.parse(interrupt.createdAt) + 15 * 60_000).toISOString()
  };
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveIntegerFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeIntegerFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function hashFrom(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value) ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function releaseIfOwned(lease: BrowserOwnershipLease, taskId: string): void {
  const owner = lease.current();
  if (owner?.ownerKind === "application" && owner.ownerId === taskId) lease.release(owner);
}

function toApiState(value: ApplicationServiceSnapshot["value"]): "created" | "observing_page" | "waiting_for_login" | "needs_questions" | "awaiting_content_review" | "awaiting_adapter_review" | "awaiting_challenge" | "filling" | "validating" | "navigating" | "review_locked" | "cancelled" | "failed" {
  const mapping: Record<ApplicationServiceSnapshot["value"], ReturnType<typeof toApiState>> = {
    created: "created",
    observing: "observing_page",
    awaiting_login: "waiting_for_login",
    needs_questions: "needs_questions",
    awaiting_content_review: "awaiting_content_review",
    awaiting_adapter_review: "awaiting_adapter_review",
    awaiting_challenge: "awaiting_challenge",
    filling: "filling",
    validating: "validating",
    navigating: "navigating",
    review_locked: "review_locked",
    cancelled: "cancelled",
    failed: "failed"
  };
  return mapping[value];
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
