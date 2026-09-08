import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@resume/contracts";
import { compareReplayDecisions, replayAgentTrace, replayStage } from "./replay-runner.js";

const events: AgentEvent[] = [
  {
    eventId: "event-1",
    runId: "run-1",
    type: "run_started",
    timestamp: "2026-09-03T00:00:00.000Z",
    actor: "runtime",
    redactionVersion: "v1"
  },
  {
    eventId: "event-2",
    runId: "run-1",
    type: "run_completed",
    timestamp: "2026-09-03T00:00:01.000Z",
    actor: "runtime",
    payloadRef: "result:run-1:completed",
    redactionVersion: "v1"
  }
];

describe("agent trace replay", () => {
  it("replays event order and terminal outcome without raw payloads", () => {
    expect(replayAgentTrace({ schemaVersion: "agent-events-v1", events })).toEqual({
      schemaVersion: "agent-events-v1",
      runId: "run-1",
      eventTypes: ["run_started", "run_completed"],
      terminalEventType: "run_completed",
      nextCursor: "event-2"
    });
  });

  it("compares rerun decisions by schema and content hash", () => {
    expect(compareReplayDecisions({
      schemaVersion: "agent-decision-v1",
      expected: { status: "blocked", reason: "stale_observation" },
      actual: { status: "blocked", reason: "stale_observation" }
    })).toMatchObject({ equal: true, schemaVersion: "agent-decision-v1" });
    expect(compareReplayDecisions({
      schemaVersion: "agent-decision-v1",
      expected: { status: "completed" },
      actual: { status: "blocked" }
    })).toMatchObject({ equal: false });
  });

  it("runs a deterministic stage callback against references only", async () => {
    const result = await replayStage({
      schemaVersion: "agent-decision-v1",
      stage: "agent",
      events,
      rerun: ({ eventTypes }) => ({ eventTypes }),
      expected: { eventTypes: ["run_started", "run_completed"] }
    });
    expect(result.equal).toBe(true);
    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});
