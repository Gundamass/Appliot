import type {
  AgentGraphState,
  ApplicationExecutionState,
  HumanResume,
  ApplicationDisplayCategory,
  ApplicationFieldCoverage,
  ApplicationQuestion,
  SubgraphName,
  FormSnapshot,
  WorkerActivity
} from "@resume/contracts";
import { BrowserOwnershipLease } from "../browser/browser-ownership-lease.js";
import type { GraphService } from "../agent/graph-service.js";
import type { SqliteAgentCheckpointer } from "../agent/sqlite-checkpointer.js";
import type { ApplicationProgressSnapshot } from "./application-progress.js";
import type {
  ApplicationService,
  ApplicationServiceSnapshot,
  ContentReview,
  StartApplicationInput
} from "./application-service.js";
import type { ApplicationTaskRepository, StoredApplicationTask } from "./application-task-repository.js";
import type { GraphApplicationReviewRepository } from "./graph-application-review-repository.js";
import type { TaskEventBus } from "./task-events.js";

interface GraphRuntimePort {
  start(input: {
    threadId: string;
    runId: string;
    taskId: string;
    subgraph: SubgraphName;
    profileRevision: number;
    application?: ApplicationExecutionState;
  }): Promise<AgentGraphState>;
  run(threadId: string): Promise<AgentGraphState>;
  resume(threadId: string, resume: HumanResume): Promise<AgentGraphState>;
  state(threadId: string): Promise<AgentGraphState | undefined>;
  cancel(threadId: string): Promise<AgentGraphState>;
}

interface GraphApplicationBrowserPort {
  open(taskId: string, url: string): Promise<unknown>;
  releaseTask?(taskId: string): Promise<void>;
}

export interface GraphApplicationServiceDependencies {
  taskRepository: ApplicationTaskRepository;
  graph: GraphRuntimePort;
  profileRevision(): number;
  browserOwnershipLease: BrowserOwnershipLease;
  browser: GraphApplicationBrowserPort;
  taskEvents?: Pick<TaskEventBus, "emit" | "emitProgress">;
  checkpointer?: Pick<SqliteAgentCheckpointer, "deleteThread">;
  reviewRepository: GraphApplicationReviewRepository;
  validateContentReview(review: ContentReview, draft: string): string[];
}

const terminalValues = new Set(["review_locked", "cancelled", "failed"]);

/**
 * Adapts graph-owned tasks to the existing HTTP-facing ApplicationService
 * contract. Browser effects remain outside graph start so a persisted task is
 * never observed before its page has been opened under the ownership lease.
 */
export function createGraphApplicationService(
  dependencies: GraphApplicationServiceDependencies
): ApplicationService {
  const graphStates = new Map<string, AgentGraphState>();
  const fallbackValues = new Map<string, ApplicationServiceSnapshot["value"]>();
  const activeRuns = new Map<string, Promise<void>>();

  const requireTask = (taskId: string): StoredApplicationTask => {
    const task = dependencies.taskRepository.get(taskId);
    if (task === undefined) throw new Error("application_task_not_found");
    if (task.orchestrator !== "agent-runtime") throw new Error("application_task_not_runtime_owned");
    return task;
  };

  const releaseIfTerminal = (taskId: string, state: ApplicationServiceSnapshot["value"]): void => {
    if (!terminalValues.has(state)) return;
    const owner = dependencies.browserOwnershipLease.current();
    if (owner?.ownerKind === "application" && owner.ownerId === taskId) {
      dependencies.browserOwnershipLease.release(owner);
    }
  };

  const publish = (taskId: string, state: AgentGraphState): AgentGraphState => {
    graphStates.set(taskId, state);
    fallbackValues.delete(taskId);
    const view = snapshotFor(taskId, state);
    dependencies.taskEvents?.emit(taskId, toApiState(view.value));
    releaseIfTerminal(taskId, view.value);
    return state;
  };

  const fetchState = async (taskId: string): Promise<AgentGraphState | undefined> => {
    const cached = graphStates.get(taskId);
    if (cached !== undefined) return cached;
    const restored = await dependencies.graph.state(threadId(taskId));
    return restored === undefined ? undefined : publish(taskId, restored);
  };

  const resume = async (
    taskId: string,
    action: "confirm" | "correct" | "approve" | "reject",
    values: Record<string, unknown> = {}
  ): Promise<void> => {
    const current = await fetchState(taskId);
    if (current?.pendingInterrupt === undefined) throw new Error("agent_resume_not_pending");
    publish(taskId, await dependencies.graph.resume(threadId(taskId), {
      interruptId: current.pendingInterrupt.id,
      action,
      values
    }));
  };

  const requireContentReview = async (taskId: string, reviewId: string) => {
    requireTask(taskId);
    const current = await fetchState(taskId);
    if (current?.status !== "interrupted" || current.pendingInterrupt?.kind !== "content_review") {
      throw new Error("content_review_not_allowed");
    }
    const review = dependencies.reviewRepository.find(taskId, reviewId);
    if (review === undefined || review.status !== "needs_review" || review.interruptId !== current.pendingInterrupt.id) {
      throw new Error("content_review_mismatch");
    }
    return { current, review };
  };

  const service: ApplicationService = {
    start(input: StartApplicationInput): void {
      requireTask(input.taskId);
      if (graphStates.has(input.taskId) || fallbackValues.has(input.taskId)) {
        throw new Error("application_task_already_started");
      }
      fallbackValues.set(input.taskId, "observing");
    },

    activeBrowserTaskId(): string | undefined {
      const owner = dependencies.browserOwnershipLease.current();
      return owner?.ownerKind === "application" ? owner.ownerId : undefined;
    },

    state(taskId: string): ApplicationServiceSnapshot {
      const task = requireTask(taskId);
      const graphState = graphStates.get(taskId);
      if (graphState !== undefined) return snapshotFor(taskId, graphState);
      return fallbackSnapshot(task, fallbackValues.get(taskId) ?? "created");
    },

    requiresRecovery(taskId: string): boolean {
      requireTask(taskId);
      return false;
    },

    async openBrowser(taskId: string): Promise<void> {
      const task = requireTask(taskId);
      const owner = dependencies.browserOwnershipLease.current();
      const newlyReserved = owner?.ownerKind !== "application" || owner.ownerId !== taskId;
      try {
        dependencies.browserOwnershipLease.acquire({ ownerKind: "application", ownerId: taskId });
      } catch (error) {
        if (error instanceof Error && error.message === "browser_lease_in_use") {
          throw new Error("browser_task_in_use");
        }
        throw error;
      }
      try {
        await dependencies.browser.open(taskId, task.applicationUrl);
        await fetchState(taskId);
      } catch (error) {
        if (newlyReserved) releaseIfOwned(dependencies.browserOwnershipLease, taskId);
        throw error;
      }
    },

    async resume(taskId: string): Promise<void> {
      const current = await fetchState(taskId);
      if (current?.pendingInterrupt?.kind === "challenge") throw new Error("challenge_resume_not_allowed");
      await resume(taskId, "confirm");
    },

    async resumeAfterChallenge(taskId: string): Promise<void> {
      const current = await fetchState(taskId);
      if (current?.pendingInterrupt?.kind !== "challenge") throw new Error("challenge_resume_not_pending");
      await resume(taskId, "confirm");
    },

    async resumeAfterAdapterCertification(_taskId: string): Promise<void> {
      throw new Error("adapter_review_not_supported");
    },

    async resumeWithProfile(taskId: string): Promise<void> {
      await resume(taskId, "confirm");
    },

    async refreshFromProfile(): Promise<void> {
      for (const task of dependencies.taskRepository.list()) {
        if (task.orchestrator !== "agent-runtime") continue;
        const current = await fetchState(task.id);
        if (current?.status === "interrupted" && current.pendingInterrupt?.kind === "missing_fact") {
          await resume(task.id, "confirm");
        }
      }
    },

    async syncTaskFromProfile(taskId: string): Promise<void> {
      requireTask(taskId);
      dependencies.taskRepository.markProfileSyncPending(taskId);
      try {
        await service.resumeWithProfile(taskId);
        dependencies.taskRepository.markProfileSyncSucceeded(taskId, dependencies.profileRevision());
      } catch (error) {
        dependencies.taskRepository.markProfileSyncFailed(taskId, "graph_profile_sync_failed");
        throw error;
      }
    },

    async answerQuestions(_taskId: string, _answers: Record<string, unknown>): Promise<void> {
      throw new Error("answer_persistence_unavailable");
    },

    contentReview(taskId: string): ContentReview | undefined {
      requireTask(taskId);
      return dependencies.reviewRepository.current(taskId);
    },

    adapterReview(taskId: string) {
      requireTask(taskId);
      return undefined;
    },

    fieldCoverage(taskId: string): ApplicationFieldCoverage | undefined {
      requireTask(taskId);
      return undefined;
    },

    async approveReview(taskId: string, reviewId: string, editedValue?: string): Promise<void> {
      const { review } = await requireContentReview(taskId, reviewId);
      const draft = editedValue ?? review.draft;
      if (dependencies.validateContentReview(review, draft).length > 0) {
        throw new Error("content_review_unsupported_edit");
      }
      const approved = dependencies.reviewRepository.approve(taskId, reviewId, draft);
      if (approved === undefined) throw new Error("content_review_mismatch");
      try {
        await resume(taskId, "approve");
      } catch (error) {
        dependencies.reviewRepository.save({ ...review, draft, status: "needs_review" });
        throw error;
      }
    },

    async rejectReview(taskId: string, reviewId: string): Promise<void> {
      const { current } = await requireContentReview(taskId, reviewId);
      const rejected = await dependencies.graph.resume(threadId(taskId), {
        interruptId: current.pendingInterrupt!.id,
        action: "reject",
        values: {}
      });
      if (rejected.status !== "failed") {
        publish(taskId, rejected);
        throw new Error("content_review_rejection_failed");
      }
      dependencies.reviewRepository.remove(taskId, reviewId);
      publish(taskId, rejected);
    },

    async cancel(taskId: string): Promise<void> {
      requireTask(taskId);
      const current = await fetchState(taskId);
      if (current === undefined) {
        fallbackValues.set(taskId, "cancelled");
        releaseIfTerminal(taskId, "cancelled");
        return;
      }
      publish(taskId, await dependencies.graph.cancel(threadId(taskId)));
      await dependencies.browser.releaseTask?.(taskId).catch(() => undefined);
    },

    dispose(taskId: string): void {
      graphStates.delete(taskId);
      fallbackValues.delete(taskId);
      activeRuns.delete(taskId);
      releaseIfOwned(dependencies.browserOwnershipLease, taskId);
      void dependencies.checkpointer?.deleteThread(threadId(taskId));
    },

    async runUntilPause(taskId: string, _initialSnapshot?: FormSnapshot): Promise<void> {
      const active = activeRuns.get(taskId);
      if (active !== undefined) return active;
      const operation = (async () => {
        const task = requireTask(taskId);
        dependencies.browserOwnershipLease.assertOwner({ ownerKind: "application", ownerId: taskId });
        const current = await fetchState(taskId);
        if (current === undefined) {
          publish(taskId, await dependencies.graph.start({
            threadId: threadId(taskId),
            runId: threadId(taskId),
            taskId,
            subgraph: "application",
            profileRevision: dependencies.profileRevision(),
            application: {
              applicationUrl: task.applicationUrl,
              executionEpoch: 0,
              retryCount: 0,
              finalReviewLocked: false
            }
          }));
          return;
        }
        if (current.status === "running") publish(taskId, await dependencies.graph.run(threadId(taskId)));
      })();
      activeRuns.set(taskId, operation);
      try {
        await operation;
      } finally {
        if (activeRuns.get(taskId) === operation) activeRuns.delete(taskId);
      }
    },

    async requestIntermediateClick(taskId: string, _actionId: string): Promise<void> {
      requireTask(taskId);
      throw new Error("intermediate_navigation_not_available");
    },

    progress(taskId: string): ApplicationProgressSnapshot {
      const graphState = graphStates.get(taskId);
      const state = this.state(taskId).value;
      return {
        status: state === "observing" ? "running" : "idle",
        busy: false,
        generation: 0,
        retryCount: graphState?.application?.retryCount ?? 0,
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
      if (activity.type !== "page_stable") return;
      if (this.state(activity.taskId).value === "observing") await this.runUntilPause(activity.taskId);
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

function threadId(taskId: string): string {
  return `application:${taskId}`;
}

function releaseIfOwned(lease: BrowserOwnershipLease, taskId: string): void {
  const owner = lease.current();
  if (owner?.ownerKind === "application" && owner.ownerId === taskId) lease.release(owner);
}

function snapshotFor(taskId: string, state: AgentGraphState): ApplicationServiceSnapshot {
  const task = {
    id: taskId,
    applicationUrl: state.application?.applicationUrl ?? "https://invalid.example/",
    name: "",
    createdAt: "",
    updatedAt: "",
    orchestrator: "agent-runtime" as const,
    profileRevisionApplied: 0,
    profileSyncStatus: "current" as const
  };
  const value = graphValue(state);
  return {
    value,
    context: {
      taskId,
      applicationUrl: task.applicationUrl,
      questions: questionsFor(state),
      errors: state.error === undefined ? [] : [state.error.code],
      ...(challengeFor(state) === undefined ? {} : { challenge: challengeFor(state) })
    }
  };
}

function fallbackSnapshot(task: StoredApplicationTask, value: ApplicationServiceSnapshot["value"]): ApplicationServiceSnapshot {
  return {
    value,
    context: { taskId: task.id, applicationUrl: task.applicationUrl, questions: [], errors: [] }
  };
}

function graphValue(state: AgentGraphState): ApplicationServiceSnapshot["value"] {
  if (state.status === "cancelled") return "cancelled";
  if (state.status === "failed") return "failed";
  if (state.status === "completed") return "review_locked";
  if (state.status === "running") return "observing";
  switch (state.pendingInterrupt?.kind) {
    case "login": return "awaiting_login";
    case "challenge": return "awaiting_challenge";
    case "final_review": return "review_locked";
    case "content_review": return "awaiting_content_review";
    case "missing_fact":
    case "fact_conflict":
    case "field_semantics":
      return "needs_questions";
    default:
      return "failed";
  }
}

function questionsFor(state: AgentGraphState): ApplicationQuestion[] {
  if (state.status !== "interrupted") return [];
  return state.pendingInterrupt?.questionIds.map((id) => ({
    id,
    fieldId: id.startsWith("field:") ? id.slice("field:".length) : id,
    text: "Provide a confirmed value for this field.",
    pageText: "The current page requires a confirmed value.",
    interpretation: "The value needs human confirmation before filling.",
    missingInformation: "No confirmed evidence is available for this field.",
    scope: "application" as const,
    inputType: "text" as const,
    options: [],
    required: true
  })) ?? [];
}

function challengeFor(state: AgentGraphState): ApplicationServiceSnapshot["context"]["challenge"] | undefined {
  if (state.pendingInterrupt?.kind !== "challenge") return undefined;
  const reasonCode = state.pendingInterrupt.reasonCode;
  return {
    kind: /captcha/iu.test(reasonCode) ? "captcha" : /rate/iu.test(reasonCode) ? "rate_limited" : "risk_control",
    detectedAt: state.pendingInterrupt.createdAt,
    reasonCode
  };
}

function toApiState(value: ApplicationServiceSnapshot["value"]): "created" | "observing_page" | "waiting_for_login" | "needs_questions" | "awaiting_content_review" | "awaiting_adapter_review" | "awaiting_challenge" | "filling" | "validating" | "navigating" | "review_locked" | "cancelled" | "failed" {
  const mapping = {
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
  } as const;
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
