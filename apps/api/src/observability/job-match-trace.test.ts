import { describe, expect, it } from "vitest";
import type { TraceSink } from "../agent/trace-sink.js";
import { BoundedJobMatchTraceBuffer, createJobMatchTraceMirror } from "./job-match-trace.js";

describe("BoundedJobMatchTraceBuffer", () => {
  it("stores only the redacted job-match trace allowlist", () => {
    const trace = new BoundedJobMatchTraceBuffer(4);
    trace.record({
      sessionId: "session-secret",
      source: "moka",
      adapterVersion: "moka-job-v1",
      scoringVersion: "job-match-v1",
      stage: "matching_jobs",
      counts: { postings: 3, recommended: 2, conflicts: 1 },
      durationMs: 25,
      contentHash: "sha256:posting",
      description: "complete private job description",
      profile: { name: "private candidate" }
    });

    expect(trace.snapshot()).toEqual([{
      sessionIdHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      source: "moka",
      adapterVersion: "moka-job-v1",
      scoringVersion: "job-match-v1",
      stage: "matching_jobs",
      counts: { postings: 3, recommended: 2, conflicts: 1 },
      durationMs: 25,
      contentHash: "sha256:posting"
    }]);
    expect(trace.snapshot()[0]).not.toHaveProperty("sessionId");
    expect(trace.snapshot()[0]).not.toHaveProperty("description");
    expect(trace.snapshot()[0]).not.toHaveProperty("profile");
  });

  it("bounds history and copies mutable count objects", () => {
    const trace = new BoundedJobMatchTraceBuffer(1);
    const counts = { postings: 1 };
    trace.record({ sessionId: "s1", stage: "created", counts });
    counts.postings = 99;
    trace.record({ sessionId: "s2", stage: "cancelled", errorCode: "cancelled_by_user" });

    expect(trace.snapshot()).toHaveLength(1);
    expect(trace.snapshot()[0]).toMatchObject({ stage: "cancelled", errorCode: "cancelled_by_user" });
  });

  it("rejects invalid limits", () => {
    expect(() => new BoundedJobMatchTraceBuffer(0)).toThrow("job_match_trace_limit_invalid");
  });

  it("mirrors graph audit events into the redacted compatibility view", () => {
    const trace = new BoundedJobMatchTraceBuffer();
    const primary: TraceSink = {
      record: () => "trace-1",
      list: () => []
    };
    const mirror = createJobMatchTraceMirror(primary, trace);

    expect(mirror.record({
      runId: "run-1",
      taskId: "session-secret",
      node: "retrieve_evidence",
      kind: "tool_call",
      outcome: "completed",
      reasonCode: "lightrag_retrieval",
      counts: { fallbackUsed: 0, lightragUsed: 1 }
    })).toBe("trace-1");
    expect(trace.snapshot()).toEqual([expect.objectContaining({
      stage: "retrieve_evidence",
      counts: { fallbackUsed: 0, lightragUsed: 1 }
    })]);
    expect(trace.snapshot()[0]).not.toHaveProperty("sessionId");
  });
});
