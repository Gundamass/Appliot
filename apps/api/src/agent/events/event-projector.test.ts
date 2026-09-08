import { describe, expect, it } from "vitest";
import { formatAgentSseEvent, projectAgentEvent } from "./event-projector.js";

describe("agent event projector", () => {
  it("projects an authoritative event to a safe SSE envelope", () => {
    const event = {
      eventId: "event-1",
      runId: "run-1",
      type: "human_interrupt" as const,
      timestamp: "2026-09-03T00:00:00.000Z",
      actor: "runtime" as const,
      payloadRef: "interrupt:interrupt-1",
      redactionVersion: "v1"
    };

    expect(projectAgentEvent(event)).toEqual({
      id: "event-1",
      event: "human_interrupt",
      data: event
    });
    expect(formatAgentSseEvent(event)).toBe(
      `id: event-1\nevent: human_interrupt\ndata: ${JSON.stringify(event)}\n\n`
    );
  });
});
