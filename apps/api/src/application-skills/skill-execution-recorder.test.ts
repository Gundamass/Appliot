import { describe, expect, it } from "vitest";
import {
  SkillBindingSchema,
  SkillExecutionRecordSchema,
  type SkillBinding,
  type SkillExecutionRecord
} from "@resume/contracts";
import {
  SkillExecutionRecorder,
  SkillExecutionRecorderInputError,
  projectReplayExecutionOutcome,
  type SkillExecutionRecordInput,
  type SkillExecutionRecordSinkPort
} from "./skill-execution-recorder.js";

describe("SkillExecutionRecorder", () => {
  it("appends one immutable, schema-valid redacted record with derived outcomes and counts", async () => {
    const sink = new MemorySink();
    const recorder = new SkillExecutionRecorder(sink);
    const input = inputFixture();

    const record = await recorder.record(input);

    expect(SkillExecutionRecordSchema.safeParse(record).success).toBe(true);
    expect(record.recordId).toMatch(/^skill-record-[a-f0-9]{32}$/u);
    expect(record.fieldOutcomes).toEqual([
      { semantic: "basics.name", outcome: "verified" },
      { semantic: "basics.email", outcome: "failed", errorClass: "readback_mismatch" },
      { semantic: "basics.phone", outcome: "skipped" }
    ]);
    expect(record.counts).toEqual({
      observed: 4,
      planned: 3,
      verified: 1,
      auditMismatches: 2,
      userCorrections: 1
    });
    expect(record.auditMismatchClasses).toEqual(["required_empty", "unexpected_value"]);
    expect(record.allocation).toBe("champion");
    expect(record.firstError).toEqual({
      stage: "write",
      errorClass: "write_failed",
      semantic: "basics.email"
    });
    expect(sink.records).toEqual([record]);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.binding)).toBe(true);
    expect(Object.isFrozen(record.fieldOutcomes)).toBe(true);
    expect(Object.isFrozen(record.fieldOutcomes[0])).toBe(true);
  });

  it("never lets a later recovery failure replace the originating first error", async () => {
    const recorder = new SkillExecutionRecorder(new MemorySink());

    const record = await recorder.record({
      ...inputFixture(),
      failures: [
        { stage: "readback", errorClass: "readback_mismatch", semantic: "basics.email" },
        { stage: "recovery", errorClass: "timeout" },
        { stage: "audit", errorClass: "audit_mismatch", semantic: "basics.email" }
      ]
    });

    expect(record.firstError).toEqual({
      stage: "readback",
      errorClass: "readback_mismatch",
      semantic: "basics.email"
    });
  });

  it("defensively copies input before freezing the persisted record", async () => {
    const sink = new MemorySink();
    const input = inputFixture();
    const record = await new SkillExecutionRecorder(sink).record(input);

    input.fieldPlans[0] = {
      semantic: "projects[].technologies",
      outcome: "missing",
      errorClass: "field_missing"
    };
    input.auditMismatchClasses[0] = "hidden_control";

    expect(record.fieldOutcomes[0]).toEqual({ semantic: "basics.name", outcome: "verified" });
    expect(record.auditMismatchClasses[0]).toBe("required_empty");
    expect(sink.records[0]).toBe(record);
  });

  it.each([
    ["name", { candidateName: "张三" }],
    ["phone", { phone: "13800138000" }],
    ["email", { email: "candidate@example.com" }],
    ["resume", { resumeText: "ten years of private employment history" }],
    ["field value", { fieldValue: "private answer" }],
    ["selector", { selector: "input[name=email]" }],
    ["DOM", { dom: "<input value='secret'>" }],
    ["screenshot", { screenshot: "data:image/png;base64,secret" }],
    ["approval token", { approvalToken: "approval-secret" }],
    ["API key", { source: "sk-proj-abc123" }],
    ["JWT", { source: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5kaWRhdGUifQ.signature123" }],
    ["query URL", { source: "https://talent.baidu.com/apply?candidate=secret" }]
  ])("rejects %s material instead of retaining it", async (_label, forbidden) => {
    const sink = new MemorySink();
    const recorder = new SkillExecutionRecorder(sink);

    await expect(recorder.record({ ...inputFixture(), ...forbidden })).rejects.toBeInstanceOf(
      SkillExecutionRecorderInputError
    );
    expect(sink.records).toHaveLength(0);
  });

  it("rejects sensitive material nested inside otherwise unknown structures", async () => {
    const sink = new MemorySink();
    const recorder = new SkillExecutionRecorder(sink);

    await expect(recorder.record({
      ...inputFixture(),
      metadata: { debug: { value: "candidate@example.com" } }
    })).rejects.toMatchObject({ code: "forbidden_sensitive_material" });
    expect(sink.records).toHaveLength(0);
  });

  it("rejects malformed counters and never appends them", async () => {
    const sink = new MemorySink();
    const recorder = new SkillExecutionRecorder(sink);

    await expect(recorder.record({ ...inputFixture(), retries: 4 })).rejects.toMatchObject({
      code: "invalid_execution_evidence"
    });
    expect(sink.records).toHaveLength(0);
  });

  it("propagates append failure and never fabricates a successful result", async () => {
    const appendFailure = new Error("append unavailable");
    const sink: SkillExecutionRecordSinkPort = {
      append: async () => {
        throw appendFailure;
      }
    };

    await expect(new SkillExecutionRecorder(sink).record(inputFixture())).rejects.toBe(appendFailure);
  });

  it("notifies lifecycle evaluation only after durable execution evidence", async () => {
    const events: string[] = [];
    const recorder = new SkillExecutionRecorder(
      { append: async () => { events.push("append"); } },
      { afterRecord: ({ auditCompleted }) => { events.push(`evaluate:${auditCompleted}`); } }
    );
    await recorder.record(inputFixture());
    expect(events).toEqual(["append", "evaluate:false"]);
  });

  it("does not evaluate a duplicate execution record twice", async () => {
    let evaluations = 0;
    const recorder = new SkillExecutionRecorder(
      { append: async () => false },
      { afterRecord: () => { evaluations += 1; } }
    );

    await recorder.record(inputFixture());

    expect(evaluations).toBe(0);
  });

  it("projects replay outcomes without task, attempt, binding, or timestamp identifiers", async () => {
    const record = await new SkillExecutionRecorder(new MemorySink()).record(inputFixture());

    const outcome = projectReplayExecutionOutcome({
      ...record,
      fieldOutcomes: [{
        ...record.fieldOutcomes[0]!,
        nodeRef: {
          documentId: "document-secret-reference",
          nodeId: "node-secret-reference",
          observedAt: 1
        }
      }, ...record.fieldOutcomes.slice(1)]
    });

    expect(outcome).toMatchObject({
      terminalResult: "failed",
      counts: record.counts,
      fieldOutcomes: record.fieldOutcomes,
      auditMismatchClasses: record.auditMismatchClasses
    });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(record.taskId);
    expect(serialized).not.toContain(record.attemptId);
    expect(serialized).not.toContain(record.binding.allocationId);
    expect(serialized).not.toContain(record.startedAt);
    expect(serialized).not.toContain("document-secret-reference");
    expect(serialized).not.toContain("node-secret-reference");
    expect(Object.isFrozen(outcome)).toBe(true);
  });
});

class MemorySink implements SkillExecutionRecordSinkPort {
  public readonly records: SkillExecutionRecord[] = [];

  public async append(record: SkillExecutionRecord): Promise<void> {
    this.records.push(record);
  }
}

function inputFixture(): SkillExecutionRecordInput {
  return {
    taskId: "application-task-1",
    attemptId: "attempt-1",
    binding: bindingFixture(),
    pageVariantId: "baidu-campus-application",
    allocation: "champion",
    observedSemantics: ["basics.name", "basics.email", "basics.phone", "education[].institution"],
    fieldPlans: [
      { semantic: "basics.name", outcome: "filled" },
      { semantic: "basics.email", outcome: "filled" },
      { semantic: "basics.phone", outcome: "skipped" }
    ],
    readbacks: [
      { semantic: "basics.name", outcome: "verified" },
      { semantic: "basics.email", outcome: "failed", errorClass: "readback_mismatch" }
    ],
    auditMismatchClasses: ["required_empty", "unexpected_value"],
    failures: [
      { stage: "write", errorClass: "write_failed", semantic: "basics.email" },
      { stage: "recovery", errorClass: "timeout" }
    ],
    userCorrections: 1,
    retries: 1,
    recoveries: 1,
    durationMs: 2_500,
    terminalResult: "failed",
    startedAt: "2026-09-07T08:00:00.000Z",
    completedAt: "2026-09-07T08:00:02.500Z"
  };
}

function bindingFixture(): SkillBinding {
  return SkillBindingSchema.parse({
    skillId: "baidu-application",
    version: "1.0.0",
    site: "baidu",
    pageFingerprintHash: "a".repeat(64),
    allocationId: "allocation-1"
  });
}
