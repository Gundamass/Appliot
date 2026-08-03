import type {
  ApplicationActivity,
  ApplicationDisplayPhase,
  ApplicationDisplayCategory,
  ApplicationOperationErrorCode,
  ApplicationTaskOperation,
  ApplicationTaskProgress,
  ApplicationTaskProgressEvent,
  OperationKind
} from "@resume/contracts";

export type ApplicationRecoveryCommand = "retry_current" | "manual_done" | "cancel";
export type ApplicationProgressStatus = "idle" | "running" | "paused";

export interface ApplicationProgressSnapshot {
  status: ApplicationProgressStatus;
  busy: boolean;
  generation: number;
  retryCount: number;
  retryCountsByField?: Record<string, number>;
  active?: ApplicationTaskProgress & { operation: ApplicationTaskOperation };
  lastResult?: ApplicationTaskProgress & { operation: ApplicationTaskOperation };
  stalledFieldId?: string;
  recovery: ApplicationRecoveryCommand[];
}

export interface StartOperationInput {
  taskId: string;
  kind: OperationKind;
  fieldId: string;
  displayCategory: ApplicationDisplayCategory;
  current: number;
  total: number;
  timeoutMs: number;
  displayPhase?: ApplicationDisplayPhase;
}

type WithoutEnvelope<Event> = Event extends {
  id: string; taskId: string; createdAt: string;
} ? Omit<Event, "id" | "taskId" | "createdAt"> : never;

type ProgressEventInput = WithoutEnvelope<ApplicationTaskProgressEvent>;

interface ActiveOperation {
  generation: number;
  startedAt: number;
  progress: ApplicationTaskProgress;
  operation: ApplicationTaskOperation;
  timeout?: ReturnType<typeof setTimeout>;
  rejectCancellation?: (error: Error) => void;
}

interface MutableTaskProgress {
  status: ApplicationProgressStatus;
  generation: number;
  retryCount: number;
  retryCountsByField: Map<string, number>;
  active: ActiveOperation | undefined;
  lastResult: ApplicationProgressSnapshot["lastResult"] | undefined;
  stalledFieldId: string | undefined;
  recovery: ApplicationRecoveryCommand[];
}

export interface ApplicationProgressCoordinatorOptions {
  now?: () => number;
  emit?: (taskId: string, event: ProgressEventInput) => void;
  persist?: (taskId: string, snapshot: ApplicationProgressSnapshot) => void;
}

export interface RunPolicyOptions {
  canRetry?: () => Promise<boolean> | boolean;
}

export interface ApplicationProgressCoordinator {
  snapshot(taskId: string): ApplicationProgressSnapshot;
  restore(taskId: string, snapshot: ApplicationProgressSnapshot): void;
  startOperation(input: StartOperationInput): { generation: number };
  completeOperation(taskId: string, generation: number): void;
  failOperation(taskId: string, generation: number, errorCode: ApplicationOperationErrorCode): void;
  recordFailure(input: StartOperationInput, errorCode: ApplicationOperationErrorCode): void;
  cancel(taskId: string): void;
  dispose(taskId: string): void;
  pause(taskId: string, reason: "user_activity" | "operation_failed" | "worker_disconnected" | "page_unstable"): void;
  resumeIfCheckpointMatches(taskId: string, matches: boolean): boolean;
  handleUserActivity(taskId: string, fieldId: string): void;
  runOperation<T>(input: StartOperationInput, operation: () => Promise<T>): Promise<T>;
  runWithPolicy<T>(input: StartOperationInput, operation: () => Promise<T>, options?: RunPolicyOptions): Promise<T>;
}

const EMPTY_SNAPSHOT: ApplicationProgressSnapshot = {
  status: "idle",
  busy: false,
  generation: 0,
  retryCount: 0,
  recovery: []
};

export function createApplicationProgressCoordinator(
  options: ApplicationProgressCoordinatorOptions = {}
): ApplicationProgressCoordinator {
  const now = options.now ?? Date.now;
  const tasks = new Map<string, MutableTaskProgress>();

  const requireTask = (taskId: string): MutableTaskProgress => {
    const current = tasks.get(taskId);
    if (current) return current;
    const created: MutableTaskProgress = {
      status: "idle", generation: 0, retryCount: 0, retryCountsByField: new Map(), active: undefined,
      lastResult: undefined, stalledFieldId: undefined, recovery: []
    };
    tasks.set(taskId, created);
    return created;
  };

  const publicSnapshot = (task: MutableTaskProgress): ApplicationProgressSnapshot => ({
    status: task.status,
    busy: task.active !== undefined,
    generation: task.generation,
    retryCount: task.retryCount,
    ...(task.retryCountsByField.size === 0
      ? {}
      : { retryCountsByField: Object.fromEntries(task.retryCountsByField) }),
    ...(task.active === undefined ? {} : {
      active: {
        ...task.active.progress,
        operation: operationAt(task.active, now())
      }
    }),
    ...(task.lastResult === undefined ? {} : { lastResult: task.lastResult }),
    ...(task.stalledFieldId === undefined ? {} : { stalledFieldId: task.stalledFieldId }),
    recovery: [...task.recovery]
  });

  const persist = (taskId: string, task: MutableTaskProgress): void => {
    options.persist?.(taskId, publicSnapshot(task));
  };

  const emit = (taskId: string, event: ProgressEventInput): void => {
    options.emit?.(taskId, event);
  };

  const settle = (
    taskId: string,
    generation: number,
    status: "succeeded" | "failed" | "timed_out",
    errorCode?: ApplicationOperationErrorCode
  ): ActiveOperation | undefined => {
    const task = requireTask(taskId);
    const active = task.active;
    if (!active || active.generation !== generation) return undefined;
    if (active.timeout) clearTimeout(active.timeout);
    task.active = undefined;
    const operation = operationAt(active, now(), status, errorCode);
    task.lastResult = { ...active.progress, operation };
    if (status === "succeeded") {
      task.status = "idle";
      task.stalledFieldId = undefined;
      task.recovery = [];
      emit(taskId, { type: "operation_completed", progress: active.progress, operation });
    } else {
      task.status = "paused";
      task.stalledFieldId = active.progress.fieldId;
      task.recovery = ["retry_current", "manual_done", "cancel"];
      emit(taskId, { type: "operation_failed", progress: active.progress, operation });
      emit(taskId, {
        type: "task_paused",
        activity: activity("user_activity", active.progress.fieldId, active.progress.displayCategory)
      });
    }
    persist(taskId, task);
    return active;
  };

  const coordinator: ApplicationProgressCoordinator = {
    snapshot(taskId) {
      const task = tasks.get(taskId);
      return task ? publicSnapshot(task) : { ...EMPTY_SNAPSHOT };
    },

    restore(taskId, snapshot) {
      const restoredRetryCounts = new Map(Object.entries(snapshot.retryCountsByField ?? {}));
      const restoredFieldId = snapshot.active?.fieldId ?? snapshot.stalledFieldId ?? snapshot.lastResult?.fieldId;
      if (restoredRetryCounts.size === 0 && restoredFieldId !== undefined && snapshot.retryCount > 0) {
        restoredRetryCounts.set(restoredFieldId, snapshot.retryCount);
      }
      tasks.set(taskId, {
        status: snapshot.busy ? "paused" : snapshot.status,
        generation: snapshot.generation,
        retryCount: snapshot.retryCount,
        retryCountsByField: restoredRetryCounts,
        active: undefined,
        lastResult: snapshot.lastResult,
        stalledFieldId: snapshot.active?.fieldId ?? snapshot.stalledFieldId,
        recovery: snapshot.busy
          ? ["retry_current", "manual_done", "cancel"]
          : [...snapshot.recovery]
      });
    },

    startOperation(input) {
      const task = requireTask(input.taskId);
      if (task.active) throw new Error("operation_already_active");
      if (task.status === "paused") throw new Error("task_paused");
      const generation = ++task.generation;
      task.retryCount = task.retryCountsByField.get(input.fieldId) ?? 0;
      const progress: ApplicationTaskProgress = {
        current: input.current,
        total: input.total,
        phase: phaseFor(input.kind),
        displayPhase: input.displayPhase ?? displayPhaseFor(input.kind),
        fieldId: input.fieldId,
        displayCategory: input.displayCategory
      };
      const operation: ApplicationTaskOperation = {
        kind: input.kind,
        status: "running",
        elapsedMs: 0,
        timeoutMs: input.timeoutMs
      };
      task.status = "running";
      task.active = { generation, startedAt: now(), progress, operation };
      task.stalledFieldId = undefined;
      task.recovery = [];
      emit(input.taskId, { type: "operation_started", progress, operation });
      persist(input.taskId, task);
      return { generation };
    },

    completeOperation(taskId, generation) {
      settle(taskId, generation, "succeeded");
    },

    failOperation(taskId, generation, errorCode) {
      settle(taskId, generation, errorCode === "TIMEOUT" ? "timed_out" : "failed", errorCode);
    },

    recordFailure(input, errorCode) {
      const task = requireTask(input.taskId);
      if (task.active) {
        settle(input.taskId, task.active.generation, "failed", errorCode);
        return;
      }
      const failureProgress: ApplicationTaskProgress = {
        current: input.current,
        total: input.total,
        phase: phaseFor(input.kind),
        displayPhase: input.displayPhase ?? displayPhaseFor(input.kind),
        fieldId: input.fieldId,
        displayCategory: input.displayCategory
      };
      const operation: ApplicationTaskOperation = {
        kind: input.kind,
        status: "failed",
        elapsedMs: 0,
        timeoutMs: input.timeoutMs,
        errorCode
      };
      task.generation += 1;
      task.status = "paused";
      task.lastResult = { ...failureProgress, operation };
      task.stalledFieldId = input.fieldId;
      task.recovery = ["retry_current", "cancel"];
      emit(input.taskId, { type: "operation_failed", progress: failureProgress, operation });
      emit(input.taskId, {
        type: "task_paused",
        activity: activity("page_changed", input.fieldId, input.displayCategory)
      });
      persist(input.taskId, task);
    },

    cancel(taskId) {
      const task = requireTask(taskId);
      const active = task.active;
      if (active?.timeout) clearTimeout(active.timeout);
      task.active = undefined;
      task.status = "idle";
      task.stalledFieldId = undefined;
      task.recovery = [];
      active?.rejectCancellation?.(new Error("operation_cancelled"));
      persist(taskId, task);
    },

    dispose(taskId) {
      const task = tasks.get(taskId);
      if (!task) return;
      if (task.active?.timeout) clearTimeout(task.active.timeout);
      task.active?.rejectCancellation?.(new Error("operation_cancelled"));
      tasks.delete(taskId);
    },

    pause(taskId, reason) {
      const task = requireTask(taskId);
      const active = task.active;
      if (active?.timeout) clearTimeout(active.timeout);
      task.active = undefined;
      task.status = "paused";
      task.stalledFieldId = active?.progress.fieldId ?? task.stalledFieldId;
      task.recovery = ["retry_current", "manual_done", "cancel"];
      active?.rejectCancellation?.(new Error(reason === "user_activity"
        ? "operation_cancelled_by_user"
        : "operation_cancelled"));
      emit(taskId, {
        type: "task_paused",
        activity: activity(
          reason === "worker_disconnected" ? "worker_disconnected" : "user_activity",
          task.stalledFieldId,
          active?.progress.displayCategory ?? "页面状态"
        )
      });
      persist(taskId, task);
    },

    resumeIfCheckpointMatches(taskId, matches) {
      const task = requireTask(taskId);
      if (!matches || task.status !== "paused") return false;
      task.status = "idle";
      task.recovery = [];
      emit(taskId, {
        type: "task_resumed",
        activity: activity("page_stable", task.stalledFieldId, "页面状态")
      });
      persist(taskId, task);
      return true;
    },

    handleUserActivity(taskId, fieldId) {
      const task = requireTask(taskId);
      if (!task.active) task.stalledFieldId = fieldId;
      coordinator.pause(taskId, "user_activity");
    },

    async runOperation<T>(input: StartOperationInput, operation: () => Promise<T>): Promise<T> {
      const { generation } = coordinator.startOperation(input);
      const task = requireTask(input.taskId);
      const active = task.active!;
      const cancellation = new Promise<never>((_resolve, reject) => {
        active.rejectCancellation = reject;
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        active.timeout = setTimeout(() => {
          coordinator.failOperation(input.taskId, generation, "TIMEOUT");
          reject(new Error("operation_timeout"));
        }, input.timeoutMs);
      });
      try {
        const result = await Promise.race([operation(), timeout, cancellation]);
        coordinator.completeOperation(input.taskId, generation);
        return result;
      } catch (error) {
        if (task.active?.generation === generation) {
          coordinator.failOperation(input.taskId, generation, "PAGE_ERROR");
        }
        throw error;
      }
    },

    async runWithPolicy<T>(
      input: StartOperationInput,
      operation: () => Promise<T>,
      policy: RunPolicyOptions = {}
    ): Promise<T> {
      try {
        return await coordinator.runOperation(input, operation);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("operation_cancelled")) throw error;
        const safeEdit = input.kind === "fill" || input.kind === "select";
        const task = requireTask(input.taskId);
        const fieldRetryCount = task.retryCountsByField.get(input.fieldId) ?? 0;
        if (!safeEdit || fieldRetryCount >= 1 || !(await policy.canRetry?.())) throw error;
        task.retryCount = fieldRetryCount + 1;
        task.retryCountsByField.set(input.fieldId, task.retryCount);
        coordinator.resumeIfCheckpointMatches(input.taskId, true);
        return coordinator.runOperation(input, operation);
      }
    }
  };

  return coordinator;
}

function operationAt(
  active: ActiveOperation,
  now: number,
  status: ApplicationTaskOperation["status"] = "running",
  errorCode?: ApplicationOperationErrorCode
): ApplicationTaskOperation {
  return {
    kind: active.operation.kind,
    status,
    elapsedMs: Math.max(0, now - active.startedAt),
    timeoutMs: active.operation.timeoutMs,
    ...(errorCode === undefined ? {} : { errorCode })
  };
}

function phaseFor(kind: OperationKind): ApplicationTaskProgress["phase"] {
  if (kind === "observe") return "observing_page";
  if (kind === "validate") return "validating";
  if (kind === "navigate") return "navigating";
  return "filling";
}

function displayPhaseFor(kind: OperationKind): ApplicationDisplayPhase {
  if (kind === "validate" || kind === "navigate") return "dynamic_validation";
  return "deterministic_fill";
}

function activity(
  kind: ApplicationActivity["kind"],
  fieldId: string | undefined,
  displayCategory: ApplicationDisplayCategory
): ApplicationActivity {
  return { kind, ...(fieldId === undefined ? {} : { fieldId }), displayCategory };
}
