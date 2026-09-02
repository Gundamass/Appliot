import { describe, expect, it } from "vitest";
import { CapabilityDescriptorSchema, FinalSubmitApprovalSchema } from "./agent-capability.js";

describe("capability contracts", () => {
  it("rejects a final submit capability without approval", () => {
    expect(() => CapabilityDescriptorSchema.parse({
      name: "final_submit",
      version: "1.0.0",
      kind: "act",
      risk: "irreversible",
      sideEffect: "external",
      allowedCallers: ["graph"],
      requiresApproval: false,
      idempotency: "none",
      timeoutMs: 30_000
    })).toThrow();
  });

  it("rejects any irreversible side effect without approval", () => {
    expect(() => CapabilityDescriptorSchema.parse({
      name: "external.publish",
      version: "1.0.0",
      kind: "act",
      risk: "high",
      sideEffect: "irreversible",
      allowedCallers: ["graph"],
      requiresApproval: false,
      idempotency: "keyed",
      timeoutMs: 30_000
    })).toThrow();
  });

  it("accepts a read capability with bounded JSON schemas", () => {
    const capability = CapabilityDescriptorSchema.parse({
      name: "browser.read_dom",
      version: "1.0.0",
      kind: "read",
      risk: "low",
      sideEffect: "none",
      allowedCallers: ["supervisor", "specialist_agent"],
      requiresApproval: false,
      idempotency: "idempotent",
      timeoutMs: 5_000,
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      handlerRef: "browser.read_dom"
    });

    expect(capability.name).toBe("browser.read_dom");
  });

  it("exposes the shared final-submit approval contract", () => {
    const approval = FinalSubmitApprovalSchema.parse({
      approvalId: "approval-1",
      token: "approval.v1.eyJhcHByb3ZhbElkIjoiYXBwcm92YWwtMSJ9.signature"
    });

    expect(approval.token).toMatch(/^approval\.v1\./u);
    expect(FinalSubmitApprovalSchema.safeParse({
      approvalId: "approval-1",
      runId: "run-1",
      planRevision: 1,
      executionEpoch: 0,
      snapshotId: "snapshot-1",
      targetFingerprint: "target-1",
      payloadHash: "a".repeat(64),
      approver: "user-1",
      issuedAt: "2026-09-03T00:00:00.000Z",
      expiresAt: "2026-09-03T00:10:00.000Z"
    }).success).toBe(false);
  });
});
