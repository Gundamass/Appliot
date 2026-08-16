import type {
  ApplicationActivity,
  ApplicationAutofillPhase,
  ApplicationDisplayPhase,
  ApplicationDisplayCategory,
  ApplicationExecutionCounts,
  ApplicationExecutionProgress,
  ApplicationOperationErrorCode,
  ApplicationPhaseStatus,
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
  attemptCountsByKey?: Record<string, number>;
  retryCountsByField?: Record<string, number>;
  active?: ApplicationTaskProgress & { operation: ApplicationTaskOperation };
  lastResult?: ApplicationTaskProgress & { operation: ApplicationTaskOperation };
  stalledFieldId?: string;
  recovery: ApplicationRecoveryCommand[];
  executionProgress?: ApplicationExecutionProgress;
}

export interface StartOperationInput {
  taskId: string;
  kind: OperationKind;
  fieldId: string;
  retryKey?: string;
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
  attemptCountsByKey: Map<string, number>;
  active: ActiveOperation | undefined;
  lastResult: ApplicationProgressSnapshot["lastResult"] | undefined;
  stalledFieldId: string | undefined;
  recovery: ApplicationRecoveryCommand[];
  executionProgress: ApplicationExecutionProgress;
}

export interface ApplicationProgressCoordinatorOptions {
  now?: () => number;
  emit?: (taskId: string, event: ProgressEventInput) => void;
  persist?: (taskId: string, snapshot: ApplicationProgressSnapshot) => void;
}

export interface RunPolicyOptions {
  canRetry?: () => Promise<boolean> | boolean;
  finalFailureMode?: "pause" | "defer";
}

export interface ApplicationProgressCoordinator {
  snapshot(taskId: string): ApplicationProgressSnapshot;
  restore(taskId: string, snapshot: ApplicationProgressSnapshot): void;
  setPhase(taskId: string, phase: ApplicationAutofillPhase, status: ApplicationPhaseStatus): void;
  setCurrentAction(taskId: string, input: ApplicationExecutionProgress["current"]): void;
  setCounts(taskId: string, counts: ApplicationExecutionCounts): void;
  startOperation(input: StartOperationInput): { generation: number };
  completeOperation(taskId: string, generation: number): void;
  failOperation(taskId: string, generation: number, errorCode: ApplicationOperationErrorCode): void;
  recordFailure(input: StartOperationInput, errorCode: ApplicationOperationErrorCode, mode?: "pause" | "defer"): void;
  cancel(taskId: string): void;
  dispose(taskId: string): void;
  pause(taskId: string, reason: "user_activity" | "operation_failed" | "worker_disconnected" | "page_unstable"): void;
  resumeIfCheckpointMatches(taskId: string, matches: boolean): boolean;
  handleUserActivity(taskId: string, fieldId: string): void;
  runOperation<T>(
    input: StartOperationInput,
    operation: () => Promise<T>,
    failureMode?: "pause" | "defer"
  ): Promise<T>;
  runWithPolicy<T>(
    input: StartOperationInput,
    operation: (attempt: 1 | 2) => Promise<T>,
    options?: RunPolicyOptions
  ): Promise<T>;
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
      status: "idle", generation: 0, retryCount: 0, attemptCountsByKey: new Map(), active: undefined,
      lastResult: undefined, stalledFieldId: undefined, recovery: [],
      executionProgress: defaultExecutionProgress("waiting_for_form")
    };
    tasks.set(taskId, created);
    return created;
  };

  const publicSnapshot = (task: MutableTaskProgress): ApplicationProgressSnapshot => ({
    status: task.status,
    busy: task.active !== undefined,
    generation: task.generation,
    retryCount: task.retryCount,
    ...(task.attemptCountsByKey.size === 0
      ? {}
      : { attemptCountsByKey: Object.fromEntries(task.attemptCountsByKey) }),
    ...(task.active === undefined ? {} : {
      active: {
        ...task.active.progress,
        operation: operationAt(task.active, now())
      }
    }),
    ...(task.lastResult === undefined ? {} : { lastResult: task.lastResult }),
    ...(task.stalledFieldId === undefined ? {} : { stalledFieldId: task.stalledFieldId }),
    recovery: [...task.recovery],
    executionProgress: cloneExecutionProgress(task.executionProgress)
  });

  const persist = (taskId: string, task: MutableTaskProgress): void => {
    options.persist?.(taskId, publicSnapshot(task));
  };

  const emit = (taskId: string, event: ProgressEventInput): void => {
    options.emit?.(taskId, event);
  };

  const publishExecutionProgress = (taskId: string, task: MutableTaskProgress): void => {
    persist(taskId, task);
    emit(taskId, {
      type: "execution_progress_changed",
      executionProgress: cloneExecutionProgress(task.executionProgress)
    });
  };

  const settle = (
    taskId: string,
    generation: number,
    status: "succeeded" | "failed" | "timed_out",
    errorCode?: ApplicationOperationErrorCode,
    failureMode: "pause" | "defer" = "pause"
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
    } else if (failureMode === "pause") {
      task.status = "paused";
      task.stalledFieldId = active.progress.fieldId;
      task.recovery = ["retry_current", "manual_done", "cancel"];
      emit(taskId, { type: "operation_failed", progress: active.progress, operation });
      emit(taskId, {
        type: "task_paused",
        activity: activity("user_activity", active.progress.fieldId, active.progress.displayCategory)
      });
    } else {
      task.status = "idle";
      task.stalledFieldId = undefined;
      task.recovery = [];
    }
    persist(taskId, task);
    return active;
  };

  const publishDeferredFailure = (taskId: string): void => {
    const task = requireTask(taskId);
    const lastResult = task.lastResult;
    if (!lastResult || (lastResult.operation.status !== "failed" && lastResult.operation.status !== "timed_out")) {
      return;
    }
    task.status = "paused";
    task.stalledFieldId = lastResult.fieldId;
    task.recovery = ["retry_current", "manual_done", "cancel"];
    const { operation, ...progress } = lastResult;
    emit(taskId, { type: "operation_failed", progress, operation });
    emit(taskId, {
      type: "task_paused",
      activity: activity("user_activity", lastResult.fieldId, lastResult.displayCategory)
    });
    persist(taskId, task);
  };

  const coordinator: ApplicationProgressCoordinator = {
    snapshot(taskId) {
      const task = tasks.get(taskId);
      return task ? publicSnapshot(task) : { ...EMPTY_SNAPSHOT };
    },

    restore(taskId, snapshot) {
      const restoredAttemptCounts = new Map(Object.entries(snapshot.attemptCountsByKey ?? {}));
      if (restoredAttemptCounts.size === 0) {
        for (const [fieldId, retryCount] of Object.entries(snapshot.retryCountsByField ?? {})) {
          restoredAttemptCounts.set(fieldId, Math.min(2, retryCount + 1));
        }
      }
      const restoredFieldId = snapshot.active?.fieldId ?? snapshot.lastResult?.fieldId;
      if (restoredAttemptCounts.size === 0 && restoredFieldId !== undefined) {
        restoredAttemptCounts.set(restoredFieldId, Math.min(2, snapshot.retryCount + 1));
      }
      tasks.set(taskId, {
        status: snapshot.busy ? "paused" : snapshot.status,
        generation: snapshot.generation,
        retryCount: snapshot.retryCount,
        attemptCountsByKey: restoredAttemptCounts,
        active: undefined,
        lastResult: snapshot.lastResult,
        stalledFieldId: snapshot.active?.fieldId ?? snapshot.stalledFieldId,
        recovery: snapshot.busy
          ? ["retry_current", "manual_done", "cancel"]
          : [...snapshot.recovery],
        executionProgress: snapshot.executionProgress === undefined
          ? executionProgressFromLegacySnapshot(snapshot)
          : cloneExecutionProgress(snapshot.executionProgress)
      });
    },

    setPhase(taskId, phase, status) {
      const task = requireTask(taskId);
      task.executionProgress = {
        ...task.executionProgress,
        currentPhase: phase,
        phases: task.executionProgress.phases.map((entry) =>
          entry.phase === phase ? { ...entry, status } : entry),
        current: { action: phaseAction(phase), maxAttempts: 2 }
      };
      publishExecutionProgress(taskId, task);
    },

    setCurrentAction(taskId, input) {
      const task = requireTask(taskId);
      task.executionProgress = {
        ...task.executionProgress,
        current: { ...input }
      };
      publishExecutionProgress(taskId, task);
    },

    setCounts(taskId, counts) {
      const task = requireTask(taskId);
      task.executionProgress = {
        ...task.executionProgress,
        counts: { ...counts }
      };
      publishExecutionProgress(taskId, task);
    },

    startOperation(input) {
      const task = requireTask(input.taskId);
      if (task.active) throw new Error("operation_already_active");
      if (task.status === "paused") throw new Error("task_paused");
      const generation = ++task.generation;
      const attempts = task.attemptCountsByKey.get(input.retryKey ?? input.fieldId) ?? 0;
      task.retryCount = Math.max(0, attempts - 1);
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

    recordFailure(input, errorCode, mode = "pause") {
      const task = requireTask(input.taskId);
      if (task.active) {
        settle(input.taskId, task.active.generation, "failed", errorCode, mode);
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
      task.status = mode === "pause" ? "paused" : "idle";
      task.lastResult = { ...failureProgress, operation };
      task.stalledFieldId = mode === "pause" ? input.fieldId : undefined;
      task.recovery = ["retry_current", "cancel"];
      emit(input.taskId, { type: "operation_failed", progress: failureProgress, operation });
      if (mode === "pause") {
        emit(input.taskId, {
          type: "task_paused",
          activity: activity("page_changed", input.fieldId, input.displayCategory)
        });
      } else {
        task.recovery = [];
      }
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
      const active = task.active;
      if (active?.timeout) clearTimeout(active.timeout);
      task.active = undefined;
      tasks.delete(taskId);
      active?.rejectCancellation?.(new Error("operation_cancelled"));
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

    async runOperation<T>(
      input: StartOperationInput,
      operation: () => Promise<T>,
      failureMode: "pause" | "defer" = "pause"
    ): Promise<T> {
      const { generation } = coordinator.startOperation(input);
      const task = requireTask(input.taskId);
      const active = task.active!;
      const cancellation = new Promise<never>((_resolve, reject) => {
        active.rejectCancellation = reject;
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        active.timeout = setTimeout(() => {
          settle(input.taskId, generation, "timed_out", "TIMEOUT", failureMode);
          reject(new Error("operation_timeout"));
        }, input.timeoutMs);
      });
      try {
        const result = await Promise.race([operation(), timeout, cancellation]);
        coordinator.completeOperation(input.taskId, generation);
        return result;
      } catch (error) {
        if (task.active?.generation === generation) {
          settle(input.taskId, generation, "failed", "PAGE_ERROR", failureMode);
        }
        throw error;
      }
    },

    async runWithPolicy<T>(
      input: StartOperationInput,
      operation: (attempt: 1 | 2) => Promise<T>,
      policy: RunPolicyOptions = {}
    ): Promise<T> {
      const task = requireTask(input.taskId);
      const retryKey = input.retryKey ?? input.fieldId;
      const reserveAttempt = (): 1 | 2 => {
        const attempts = task.attemptCountsByKey.get(retryKey) ?? 0;
        if (attempts >= 2) throw new Error("automatic_attempt_limit_reached");
        const nextAttempt = (attempts + 1) as 1 | 2;
        task.attemptCountsByKey.set(retryKey, nextAttempt);
        task.retryCount = nextAttempt - 1;
        persist(input.taskId, task);
        return nextAttempt;
      };
      const firstAttempt = reserveAttempt();
      const safeEdit = input.kind === "fill" || input.kind === "select";
      const canAttemptAutomaticRetry = safeEdit && firstAttempt < 2 && policy.canRetry !== undefined;
      const finalFailureMode = policy.finalFailureMode ?? "pause";
      try {
        return await coordinator.runOperation(
          input,
          () => operation(firstAttempt),
          canAttemptAutomaticRetry ? "defer" : finalFailureMode
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("operation_cancelled")) throw error;
        if (!canAttemptAutomaticRetry) throw error;
        let canRetry: boolean;
        try {
          canRetry = await policy.canRetry!();
        } catch {
          if (finalFailureMode === "pause") publishDeferredFailure(input.taskId);
          throw error;
        }
        if (!canRetry) {
          if (finalFailureMode === "pause") publishDeferredFailure(input.taskId);
          throw error;
        }
        const secondAttempt = reserveAttempt();
        return coordinator.runOperation(input, () => operation(secondAttempt), finalFailureMode);
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

const AUTOFILL_PHASES: readonly ApplicationAutofillPhase[] = [
  "waiting_for_form",
  "deterministic_fill",
  "semantic_fill",
  "readback_validation",
  "final_review"
];

function defaultExecutionProgress(currentPhase: ApplicationAutofillPhase): ApplicationExecutionProgress {
  const currentIndex = AUTOFILL_PHASES.indexOf(currentPhase);
  return {
    currentPhase,
    phases: AUTOFILL_PHASES.map((phase, index) => ({
      phase,
      status: index < currentIndex ? "completed" : index === currentIndex ? "running" : "pending"
    })),
    current: { action: phaseAction(currentPhase), maxAttempts: 2 },
    counts: { exact: 0, semantic: 0, user: 0, missing: 0, failed: 0 }
  };
}

function cloneExecutionProgress(progress: ApplicationExecutionProgress): ApplicationExecutionProgress {
  return {
    currentPhase: progress.currentPhase,
    phases: progress.phases.map((phase) => ({ ...phase })),
    current: { ...progress.current },
    counts: { ...progress.counts }
  };
}

function executionProgressFromLegacySnapshot(snapshot: ApplicationProgressSnapshot): ApplicationExecutionProgress {
  const operation = snapshot.active ?? snapshot.lastResult;
  if (operation === undefined) return defaultExecutionProgress("waiting_for_form");
  if (operation.displayPhase === "semantic_fill") return defaultExecutionProgress("semantic_fill");
  if (operation.displayPhase === "review_handoff") return defaultExecutionProgress("final_review");
  if (operation.displayPhase === "dynamic_validation" || operation.operation.kind === "validate") {
    return defaultExecutionProgress("readback_validation");
  }
  return defaultExecutionProgress("deterministic_fill");
}

function phaseAction(phase: ApplicationAutofillPhase): string {
  switch (phase) {
    case "waiting_for_form": return "等待进入简历填写页";
    case "deterministic_fill": return "正在进行精确字段填写";
    case "semantic_fill": return "正在进行语义补全";
    case "readback_validation": return "正在校验页面填写结果";
    case "final_review": return "等待用户最终审核";
  }
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
