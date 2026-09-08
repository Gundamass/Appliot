import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import { createInMemoryAgentEventTraceSink } from "./trace-sink.js";
import { createSseEventWriter, registerAgentRuntimeRoutes } from "./routes.js";

const interrupt = {
  interruptId: "interrupt-1",
  reason: "authentication" as const,
  summary: "Please sign in.",
  evidenceRefs: [],
  expiresAt: "2026-09-03T01:00:00.000Z"
};

describe("agent runtime routes", () => {
  it("does not duplicate an event when replay and live delivery overlap", () => {
    const chunks: string[] = [];
    const event = createInMemoryAgentEventTraceSink({ now: () => "2026-09-03T00:00:00.000Z" }).record({
      runId: "run-1",
      type: "run_started",
      actor: "runtime",
      redactionVersion: "v1"
    });
    const writer = createSseEventWriter((chunk) => chunks.push(chunk));

    writer(event);
    writer(event);

    expect(chunks).toHaveLength(1);
  });

  it("publishes lifecycle events and replays them by cursor", async () => {
    const runtime: AgentRuntime = {
      async start() {
        return { runId: "run-1", status: "interrupted" as const, pendingInterrupt: interrupt };
      },
      async resume() {
        return { runId: "run-1", status: "completed" as const, summary: "done" };
      },
      async cancel() {
        return { runId: "run-1", status: "cancelled" as const };
      },
      async recover() {
        return { runId: "run-1", status: "completed" as const };
      },
      async inspect() {
        throw new Error("not_used");
      }
    };
    const events = createInMemoryAgentEventTraceSink({ now: () => "2026-09-03T00:00:00.000Z" });
    const app = Fastify({ logger: false });
    registerAgentRuntimeRoutes(app, { runtime, events });

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/runs",
      payload: { goal: "帮我分析简历", requestedBy: "user-1" }
    });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({ runId: "run-1", status: "interrupted" });

    const replay = await app.inject({ method: "GET", url: "/api/agent/runs/run-1/events" });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().events.map((event: { type: string }) => event.type)).toEqual([
      "run_started",
      "human_interrupt"
    ]);

    const cursor = replay.json().nextCursor as string;
    const resumed = await app.inject({
      method: "POST",
      url: "/api/agent/runs/run-1/resume",
      payload: { interruptId: "interrupt-1", action: "confirm", values: {} }
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ runId: "run-1", status: "completed" });

    const afterResume = await app.inject({
      method: "GET",
      url: `/api/agent/runs/run-1/events?after=${encodeURIComponent(cursor)}`
    });
    expect(afterResume.json().events.map((event: { type: string }) => event.type)).toEqual([
      "clarification_received",
      "run_completed"
    ]);
    await app.close();
  });

  it("returns a structured 404 for an unknown run", async () => {
    const runtime = {
      start: async () => ({ runId: "run-1", status: "completed" as const }),
      resume: async () => ({ runId: "run-1", status: "completed" as const }),
      cancel: async () => ({ runId: "run-1", status: "cancelled" as const }),
      recover: async () => ({ runId: "run-1", status: "completed" as const }),
      inspect: async () => { throw new Error("agent_run_not_found"); }
    } as unknown as AgentRuntime;
    const app = Fastify({ logger: false });
    registerAgentRuntimeRoutes(app, {
      runtime,
      events: createInMemoryAgentEventTraceSink()
    });

    const response = await app.inject({ method: "GET", url: "/api/agent/runs/missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "agent_run_not_found" });
    await app.close();
  });
});
