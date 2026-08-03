import type { ExecutableCommand, FormSnapshot } from "@resume/contracts";
import { describe, expect, it } from "vitest";
import { ApprovalStore } from "./approval-store.js";
import { ActionPolicy, PolicyDeniedError, verifyAndConsumeApproval } from "./policy.js";

const key = Buffer.alloc(32, 7);

function snapshot(actionClass: FormSnapshot["actions"][number]["class"] = "intermediate_navigation"): FormSnapshot {
  return {
    id: "snapshot-1",
    taskId: "task-1",
    url: "https://ats.example.test/application",
    title: "招聘申请",
    stage: actionClass === "terminal_submit" ? "review" : "application_form",
    fields: [{
      id: "field-email",
      label: "邮箱",
      type: "text",
      required: true,
      options: [],
      currentValue: ""
    }],
    actions: [{ id: "action-next", text: "下一步", class: actionClass }],
    errors: []
  };
}

describe("action policy", () => {
  it("never approves terminal or unknown actions", () => {
    const policy = new ActionPolicy(key);
    for (const actionClass of ["terminal_submit", "unknown_side_effect"] as const) {
      expect(() => policy.approve({
        taskId: "task-1",
        snapshotId: "snapshot-1",
        targetId: "action-next",
        operation: "click_intermediate"
      }, snapshot(actionClass), { valid: true })).toThrow(PolicyDeniedError);
    }
  });

  it("approves intermediate navigation only after page validation", () => {
    const policy = new ActionPolicy(key);
    const request = {
      taskId: "task-1",
      snapshotId: "snapshot-1",
      targetId: "action-next",
      operation: "click_intermediate" as const
    };

    expect(() => policy.approve(request, snapshot(), { valid: false })).toThrow("page_not_valid");
    expect(policy.approve(request, snapshot(), { valid: true })).toMatchObject({
      taskId: "task-1",
      snapshotId: "snapshot-1",
      targetId: "action-next",
      operation: "click_intermediate",
      oneUse: true
    });
  });

  it("binds a fill approval to one task, snapshot, target and operation and rejects replay", () => {
    let now = 1_000;
    const policy = new ActionPolicy(key, { now: () => now });
    const approval = policy.approve({
      taskId: "task-1",
      snapshotId: "snapshot-1",
      targetId: "field-email",
      operation: "fill"
    }, snapshot());
    const command: ExecutableCommand = {
      type: "fill",
      taskId: "task-1",
      snapshotId: "snapshot-1",
      fieldId: "field-email",
      value: "me@example.com",
      approval: approval.token
    };
    const store = new ApprovalStore();

    expect(verifyAndConsumeApproval(command, key, store, { now: () => now })).toMatchObject({ targetId: "field-email" });
    expect(() => verifyAndConsumeApproval(command, key, store, { now: () => now })).toThrow("approval_replayed");

    const altered = { ...command, fieldId: "field-name" };
    expect(() => verifyAndConsumeApproval(altered, key, new ApprovalStore(), { now: () => now })).toThrow("approval_target_mismatch");
    now = 31_001;
    expect(() => verifyAndConsumeApproval(command, key, new ApprovalStore(), { now: () => now })).toThrow("approval_expired");
  });

  it("rejects a tampered approval signature", () => {
    const policy = new ActionPolicy(key);
    const approval = policy.approve({
      taskId: "task-1",
      snapshotId: "snapshot-1",
      targetId: "field-email",
      operation: "fill"
    }, snapshot());
    const command: ExecutableCommand = {
      type: "fill",
      taskId: "task-1",
      snapshotId: "snapshot-1",
      fieldId: "field-email",
      value: "me@example.com",
      approval: (() => {
        const separator = approval.token.indexOf(".");
        const signatureStart = separator + 1;
        const firstSignatureCharacter = approval.token[signatureStart];
        const replacement = firstSignatureCharacter === "A" ? "B" : "A";
        return `${approval.token.slice(0, signatureStart)}${replacement}${approval.token.slice(signatureStart + 1)}`;
      })()
    };

    expect(() => verifyAndConsumeApproval(command, key, new ApprovalStore())).toThrow("approval_signature_invalid");
  });
});
