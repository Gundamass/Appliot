import { createHash } from "node:crypto";
import type { JobSource } from "@resume/contracts";
import type { TraceSink } from "../agent/trace-sink.js";

export interface JobMatchTraceInput {
  sessionId: string;
  source?: JobSource;
  adapterVersion?: string;
  scoringVersion?: "job-match-v1";
  stage: string;
  counts?: Record<string, number>;
  durationMs?: number;
  errorCode?: string;
  contentHash?: string;
  [key: string]: unknown;
}

export interface JobMatchTraceEvent {
  sessionIdHash: string;
  source?: JobSource;
  adapterVersion?: string;
  scoringVersion?: "job-match-v1";
  stage: string;
  counts?: Record<string, number>;
  durationMs?: number;
  errorCode?: string;
  contentHash?: string;
}

export interface JobMatchTraceSink {
  record(event: JobMatchTraceInput): void;
}

export function createJobMatchTraceMirror(primary: TraceSink, compatibility?: JobMatchTraceSink): TraceSink {
  if (compatibility === undefined) return primary;
  return {
    record(input) {
      const id = primary.record(input);
      try {
        compatibility.record({
          sessionId: input.taskId,
          stage: input.node,
          ...(input.counts === undefined ? {} : { counts: input.counts }),
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
          ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
          ...(input.outcome === "failed" || input.kind === "safety_block" ? { errorCode: input.reasonCode } : {})
        });
      } catch {
        // A compatibility view must not alter the authoritative audit path.
      }
      return id;
    },
    list(runId) {
      return primary.list(runId);
    }
  };
}

export class BoundedJobMatchTraceBuffer implements JobMatchTraceSink {
  private readonly events: JobMatchTraceEvent[] = [];

  constructor(private readonly limit = 200) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("job_match_trace_limit_invalid");
  }

  record(input: JobMatchTraceInput): void {
    const event: JobMatchTraceEvent = {
      sessionIdHash: `sha256:${createHash("sha256").update(input.sessionId).digest("hex")}`,
      stage: input.stage,
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.adapterVersion === undefined ? {} : { adapterVersion: input.adapterVersion }),
      ...(input.scoringVersion === undefined ? {} : { scoringVersion: input.scoringVersion }),
      ...(input.counts === undefined ? {} : { counts: { ...input.counts } }),
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash })
    };
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }

  snapshot(): JobMatchTraceEvent[] {
    return this.events.map((event) => ({
      ...event,
      ...(event.counts === undefined ? {} : { counts: { ...event.counts } })
    }));
  }
}
