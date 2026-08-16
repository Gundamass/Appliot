import { describe, expect, it } from "vitest";
import { BoundedRuntimeTraceBuffer, type RuntimeTraceEvent } from "./runtime-trace.js";

function traceEvent(elapsedMs: number): RuntimeTraceEvent {
  return {
    taskIdHash: "task-hash",
    snapshotId: "snapshot-1",
    documentId: "document-identity",
    mutationEpoch: 7,
    nodeRefHash: "node-hash",
    phase: "prepare",
    elapsedMs,
    resultCode: "ok"
  };
}

describe("BoundedRuntimeTraceBuffer", () => {
  it("keeps only the newest 1,000 allowlisted events", () => {
    const buffer = new BoundedRuntimeTraceBuffer();
    for (let index = 0; index <= 1_000; index += 1) buffer.record(traceEvent(index));

    const entries = buffer.entries();
    expect(entries).toHaveLength(1_000);
    expect(entries[0]?.elapsedMs).toBe(1);
    expect(entries.at(-1)?.elapsedMs).toBe(1_000);
  });

  it("does not retain values, labels, selectors, coordinates, or DOM", () => {
    const buffer = new BoundedRuntimeTraceBuffer();
    buffer.record({
      ...traceEvent(1),
      value: "candidate-secret",
      label: "Candidate email",
      selector: "#email",
      coordinates: { x: 12, y: 24 },
      dom: "<input value='candidate-secret'>"
    } as RuntimeTraceEvent);

    const serialized = JSON.stringify(buffer.entries());
    expect(serialized).not.toContain("candidate-secret");
    expect(serialized).not.toContain("Candidate email");
    expect(serialized).not.toContain("#email");
    expect(serialized).not.toContain("coordinates");
    expect(serialized).not.toContain("<input");
  });
});
