import { describe, expect, it } from "vitest";
import {
  BoundedEmbeddingTraceBuffer,
  type EmbeddingTraceEvent
} from "./embedding-trace.js";

function event(batchSize: number): EmbeddingTraceEvent {
  return {
    operation: "documents",
    cacheKeyHash: "a".repeat(64),
    batchSize,
    queueWaitMs: 0,
    deepSeekUsed: false,
    result: "succeeded"
  };
}

describe("BoundedEmbeddingTraceBuffer", () => {
  it("keeps the newest 1000 sanitized events in FIFO order", () => {
    const buffer = new BoundedEmbeddingTraceBuffer();

    for (let index = 1; index <= 1_001; index += 1) buffer.record(event(index));

    const snapshot = buffer.snapshot();
    expect(snapshot).toHaveLength(1_000);
    expect(snapshot[0]).toMatchObject({ batchSize: 2 });
    expect(snapshot[999]).toMatchObject({ batchSize: 1_001 });
  });

  it("drops unhashed cache keys and raw provider messages", () => {
    const buffer = new BoundedEmbeddingTraceBuffer();
    const sensitive = "confidential field text and api-token-value";

    buffer.record({
      operation: "ontology_build",
      cacheKeyHash: sensitive,
      providerErrorKind: sensitive,
      deepSeekUsed: false,
      result: "failed"
    });

    expect(buffer.snapshot()).toEqual([{
      operation: "ontology_build",
      providerErrorKind: "unknown",
      deepSeekUsed: false,
      result: "failed"
    }]);
    expect(JSON.stringify(buffer.snapshot())).not.toContain(sensitive);
  });

  it("returns snapshots that cannot mutate buffered events", () => {
    const buffer = new BoundedEmbeddingTraceBuffer();
    buffer.record(event(1));
    const snapshot = buffer.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });
});
