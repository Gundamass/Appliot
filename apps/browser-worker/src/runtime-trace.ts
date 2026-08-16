import { createHash } from "node:crypto";

export type RuntimeTracePhase =
  | "prepare"
  | "apply"
  | "settle-1"
  | "readback-1"
  | "settle-2"
  | "readback-2";

export interface RuntimeTraceEvent {
  taskIdHash: string;
  snapshotId: string;
  documentId: string;
  mutationEpoch: number;
  nodeRefHash: string;
  phase: RuntimeTracePhase;
  elapsedMs: number;
  resultCode: string;
}

export interface RuntimeTraceSink {
  record(event: RuntimeTraceEvent): void;
}

const MAX_TRACE_EVENTS = 1_000;

export class BoundedRuntimeTraceBuffer implements RuntimeTraceSink {
  private readonly events: RuntimeTraceEvent[] = [];

  record(event: RuntimeTraceEvent): void {
    this.events.push({
      taskIdHash: event.taskIdHash,
      snapshotId: event.snapshotId,
      documentId: event.documentId,
      mutationEpoch: event.mutationEpoch,
      nodeRefHash: event.nodeRefHash,
      phase: event.phase,
      elapsedMs: event.elapsedMs,
      resultCode: event.resultCode
    });
    if (this.events.length > MAX_TRACE_EVENTS) this.events.shift();
  }

  entries(): RuntimeTraceEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}

export function runtimeTraceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
