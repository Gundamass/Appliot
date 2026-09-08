import { describe, expect, it } from "vitest";
import { createApprovalSystem } from "./approval-gate.js";

const binding = {
  runId: "run-1",
  planRevision: 3,
  executionEpoch: 2,
  snapshotId: "snapshot-1",
  targetFingerprint: "target-fingerprint-1",
  payloadHash: "a".repeat(64)
};

function system(now = "2026-09-03T00:05:00.000Z") {
  return createApprovalSystem({
    signingKey: Buffer.alloc(32, 7),
    now: () => now,
    verifyHumanPrincipal: (principal) => principal === "authenticated:user-1"
      ? { subject: "user-1" }
      : undefined
  });
}

describe("ApprovalGate", () => {
  it("accepts only a server-issued signed approval and binds it to the complete request", () => {
    const approvals = system();
    const approval = approvals.issuer.issue({ binding, principal: "authenticated:user-1" });

    expect(approvals.gate.verify(approval, binding)).toMatchObject({
      valid: true,
      approvalId: expect.any(String)
    });
    expect(approvals.gate.verify({
      approvalId: "approval-1",
      ...binding,
      approver: "user-1",
      issuedAt: "2026-09-03T00:00:00.000Z",
      expiresAt: "2026-09-03T00:10:00.000Z"
    }, binding)).toEqual({ valid: false, reason: "approval_invalid" });
    expect(approvals.gate.verify(approval, { ...binding, payloadHash: "b".repeat(64) }))
      .toEqual({ valid: false, reason: "payload_hash_mismatch" });
  });

  it("requires an authenticated human principal and rejects expired approvals", () => {
    const approvals = system();
    expect(() => approvals.issuer.issue({ binding, principal: "model" }))
      .toThrow("human_approval_principal_invalid");

    const expired = system("2026-09-03T00:11:00.000Z");
    const approval = expired.issuer.issue({
      binding,
      principal: "authenticated:user-1",
      expiresAt: "2026-09-03T00:10:00.000Z"
    });
    expect(expired.gate.verify(approval, binding)).toEqual({ valid: false, reason: "approval_expired" });
  });

  it("caps issuer-provided expiry at the configured approval TTL", () => {
    const approvals = createApprovalSystem({
      signingKey: Buffer.alloc(32, 8),
      now: () => "2026-09-03T00:00:00.000Z",
      ttlMs: 60_000,
      verifyHumanPrincipal: () => ({ subject: "user-1" })
    });

    expect(() => approvals.issuer.issue({
      binding,
      principal: "authenticated:user-1",
      expiresAt: "2026-09-03T00:02:00.000Z"
    })).toThrow("human_approval_expiry_exceeds_ttl");
  });

  it("does not consume an approval during verification and consumes it once", () => {
    const approvals = system();
    const approval = approvals.issuer.issue({ binding, principal: "authenticated:user-1" });

    expect(approvals.gate.verify(approval, binding)).toMatchObject({ valid: true });
    expect(approvals.gate.isConsumed(approval.approvalId)).toBe(false);
    expect(approvals.gate.consume(approval.approvalId)).toBe(true);
    expect(approvals.gate.consume(approval.approvalId)).toBe(false);
    expect(approvals.gate.verify(approval, binding)).toEqual({ valid: false, reason: "approval_replayed" });
  });
});
