import { describe, expect, it } from "vitest";
import {
  AgentGraphStateSchema,
  ApplicationExecutionStateSchema,
  AuditTraceInputSchema,
  HumanResumeSchema
} from "./agent-graph.js";

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

  it("accepts only safe Skill trace dimensions", () => {
    const skill = {
      skillId: "baidu-campus-application",
      skillVersion: "1.0.0",
      pageFingerprintHash: "a".repeat(64),
      pageVariantId: "application-form",
      allocation: "champion" as const
    };

    expect(AuditTraceInputSchema.parse({
      runId: "run-1", taskId: "task-1", node: "execute_plan", kind: "tool_call",
      outcome: "completed", reasonCode: "command_applied", skill
    })).toMatchObject({ skill });

    expect(() => AuditTraceInputSchema.parse({
      runId: "run-1", taskId: "task-1", node: "execute_plan", kind: "tool_call",
      outcome: "completed", reasonCode: "command_applied",
      skill: { ...skill, pageVariantId: "https://example.test/form?token=secret" }
    })).toThrow();
  });

  it("keeps persisted Skill trace dimensions bound to the same immutable version", () => {
    const skillBinding = {
      skillId: "baidu-application", version: "1.0.0", site: "baidu" as const,
      pageFingerprintHash: "a".repeat(64), allocationId: "allocation-baidu"
    };
    const skillTrace = {
      skillId: skillBinding.skillId,
      skillVersion: skillBinding.version,
      pageFingerprintHash: skillBinding.pageFingerprintHash,
      pageVariantId: "application-form",
      allocation: "champion" as const
    };
    const application = {
      applicationUrl: "https://talent.baidu.com/jobs/detail/GRADUATE/123/apply",
      executionEpoch: 1, retryCount: 0, finalReviewLocked: false,
      skillBinding, skillTrace
    };

    expect(ApplicationExecutionStateSchema.parse(application)).toMatchObject({ skillBinding, skillTrace });
    expect(() => ApplicationExecutionStateSchema.parse({
      ...application,
      skillTrace: { ...skillTrace, skillVersion: "2.0.0" }
    })).toThrow("skill_trace_binding_mismatch");
  });

  it.each([
    { candidateIds: ["candidate@example.com"] },
    { evidenceIds: ["input[name=email]"] },
    { candidateIds: ["approval_token_secret"] },
    { reasonCode: "sk-proj-abc123" },
    { candidateIds: ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5kaWRhdGUifQ.signature123"] },
    { toolName: "sk-proj-abc123" },
    { errorCode: "approval_token_secret" },
    { contentHash: "https://example.test/apply?token=secret" },
    { counts: { "<input-value>": 1 } }
  ])("rejects sensitive material smuggled through trace metadata", (unsafe) => {
    expect(() => AuditTraceInputSchema.parse({
      runId: "run-1", taskId: "task-1", node: "execute_plan", kind: "tool_call",
      outcome: "completed", reasonCode: "command_applied", ...unsafe
    })).toThrow();
  });

  it("requires the interrupt id when work resumes", () => {
    expect(HumanResumeSchema.parse({ interruptId: "int-1", action: "confirm", values: {} }).action)
      .toBe("confirm");
  });
});
