export interface CancellationRegistration {
  readonly runId: string;
  readonly executionEpoch: number;
  readonly signal: AbortSignal;
}

export interface CancellationManager {
  register(runId: string, executionEpoch?: number): CancellationRegistration;
  renew(runId: string, executionEpoch: number): CancellationRegistration;
  cancel(runId: string): boolean;
  isCancelled(runId: string): boolean;
  signal(runId: string): AbortSignal;
  currentEpoch(runId: string): number;
  assertActive(runId: string): void;
  forget(runId: string): void;
}

interface CancellationEntry {
  controller: AbortController;
  executionEpoch: number;
  cancelled: boolean;
}

export function createCancellationManager(): CancellationManager {
  const entries = new Map<string, CancellationEntry>();

  const requireEntry = (runId: string): CancellationEntry => {
    if (runId.length === 0) throw new Error("agent_run_id_required");
    const entry = entries.get(runId);
    if (entry === undefined) throw new Error("agent_run_not_found");
    return entry;
  };

  const create = (runId: string, executionEpoch: number): CancellationRegistration => {
    if (runId.length === 0) throw new Error("agent_run_id_required");
    if (!Number.isInteger(executionEpoch) || executionEpoch < 0) {
      throw new Error("agent_execution_epoch_invalid");
    }
    const entry: CancellationEntry = {
      controller: new AbortController(),
      executionEpoch,
      cancelled: false
    };
    entries.set(runId, entry);
    return { runId, executionEpoch, signal: entry.controller.signal };
  };

  return {
    register(runId, executionEpoch = 0) {
      const existing = entries.get(runId);
      if (existing !== undefined && !existing.cancelled) {
        return { runId, executionEpoch: existing.executionEpoch, signal: existing.controller.signal };
      }
      return create(runId, executionEpoch);
    },
    renew(runId, executionEpoch) {
      const previous = entries.get(runId);
      previous?.controller.abort("execution_epoch_renewed");
      return create(runId, executionEpoch);
    },
    cancel(runId) {
      const entry = entries.get(runId);
      if (entry === undefined) return false;
      if (!entry.cancelled) entry.controller.abort("cancelled");
      entry.cancelled = true;
      return true;
    },
    isCancelled(runId) {
      return entries.get(runId)?.cancelled ?? false;
    },
    signal(runId) {
      return requireEntry(runId).controller.signal;
    },
    currentEpoch(runId) {
      return requireEntry(runId).executionEpoch;
    },
    assertActive(runId) {
      const entry = requireEntry(runId);
      if (entry.cancelled || entry.controller.signal.aborted) throw new Error("agent_run_cancelled");
    },
    forget(runId) {
      entries.delete(runId);
    }
  };
}
