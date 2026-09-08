import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrateDatabase } from "../../db/migrate.js";
import { createInMemoryAgentEventTraceSink, createSqliteAgentEventTraceSink } from "./trace-sink.js";

describe("agent event trace sink", () => {
  it("records typed events and replays from an event cursor", () => {
    const sink = createInMemoryAgentEventTraceSink({ now: () => "2026-09-03T00:00:00.000Z" });

    const first = sink.record({
      runId: "run-1",
      type: "run_started",
      actor: "runtime",
      redactionVersion: "v1"
    });
    const second = sink.record({
      runId: "run-1",
      type: "checkpoint_saved",
      actor: "runtime",
      payloadRef: "checkpoint:run-1",
      redactionVersion: "v1"
    });

    expect(first.eventId).not.toBe(second.eventId);
    expect(sink.replay("run-1", first.eventId).events).toEqual([second]);
    expect(sink.replay("run-1", first.eventId).nextCursor).toBe(second.eventId);
  });

  it("publishes events to subscribers without exposing raw payloads", () => {
    const sink = createInMemoryAgentEventTraceSink();
    const listener = vi.fn();
    const unsubscribe = sink.subscribe("run-1", listener);

    sink.record({
      runId: "run-1",
      type: "intent_resolved",
      actor: "runtime",
      payloadRef: "intent:intent-1",
      redactionVersion: "v1"
    });
    unsubscribe();
    sink.record({
      runId: "run-1",
      type: "plan_created",
      actor: "runtime",
      payloadRef: "plan:plan-1",
      redactionVersion: "v1"
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ type: "intent_resolved" });
    expect(JSON.stringify(listener.mock.calls[0]?.[0])).not.toContain("password");
  });

  it("rejects sensitive references before persistence", () => {
    const sink = createInMemoryAgentEventTraceSink();

    expect(() => sink.record({
      runId: "run-1",
      type: "run_started",
      actor: "runtime",
      payloadRef: "prompt:password=secret",
      redactionVersion: "v1"
    })).toThrow("agent_event_pii_rejected");
    expect(sink.list("run-1")).toEqual([]);
  });

  it("persists the same redacted event contract in SQLite", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const sink = createSqliteAgentEventTraceSink(database, { now: () => "2026-09-03T00:00:00.000Z" });

    const event = sink.record({
      runId: "run-1",
      intentId: "intent-1",
      planId: "plan-1",
      planRevision: 1,
      stepId: "step-1",
      type: "plan_created",
      actor: "runtime",
      payloadRef: "plan:plan-1",
      redactionVersion: "v1"
    });

    expect(sink.list("run-1")).toEqual([event]);
    expect(database.prepare("SELECT payload_json FROM agent_events").get()).toEqual({
      payload_json: JSON.stringify(event)
    });
    database.close();
  });
});
