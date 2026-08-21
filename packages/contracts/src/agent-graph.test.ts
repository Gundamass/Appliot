import { describe, expect, it } from "vitest";
import { AgentGraphStateSchema, AuditTraceInputSchema, HumanResumeSchema } from "./agent-graph.js";

describe("agent graph contracts", () => {
  it("accepts reference-only graph state", () => {
    expect(AgentGraphStateSchema.parse({
      threadId: "thread-1", runId: "run-1", taskId: "task-1", graphVersion: "agent-v1",
      status: "running", profileRevision: 3, currentSubgraph: "application", auditEventIds: []
    }).status).toBe("running");
  });

  it("rejects unbounded sensitive trace payloads", () => {
    expect(() => AuditTraceInputSchema.parse({
      runId: "run-1", taskId: "task-1", node: "resolve", kind: "model_decision",
      outcome: "accepted", reasonCode: "candidate_supported", email: "person@example.com"
    })).toThrow();
  });

  it("requires the interrupt id when work resumes", () => {
    expect(HumanResumeSchema.parse({ interruptId: "int-1", action: "confirm", values: {} }).action)
      .toBe("confirm");
  });
});
