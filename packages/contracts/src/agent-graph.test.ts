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

  it("accepts bounded tool trace metadata", () => {
    expect(AuditTraceInputSchema.parse({
      runId: "run-1", taskId: "task-1", node: "conversation_execute_read", kind: "tool_call",
      toolName: "list_recommendations", outcome: "completed", reasonCode: "tool_completed",
      durationMs: 12, errorCode: "tool_timeout"
    })).toMatchObject({ toolName: "list_recommendations", durationMs: 12, errorCode: "tool_timeout" });
  });

  it("requires the interrupt id when work resumes", () => {
    expect(HumanResumeSchema.parse({ interruptId: "int-1", action: "confirm", values: {} }).action)
      .toBe("confirm");
  });
});
