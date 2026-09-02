import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  FinalSubmitApprovalSchema,
  type FinalSubmitApproval
} from "@resume/contracts";
import { z } from "zod";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/iu);

const ApprovalBindingSchema = z.object({
  runId: z.string().min(1).max(128),
  planRevision: z.number().int().positive(),
  executionEpoch: z.number().int().nonnegative(),
  snapshotId: z.string().min(1).max(256),
  targetFingerprint: z.string().min(1).max(256),
  payloadHash: HashSchema
}).strict();

const ApprovalClaimsSchema = ApprovalBindingSchema.extend({
  approvalId: z.string().min(1).max(128),
  approver: z.string().min(1).max(256),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict();

export { FinalSubmitApprovalSchema };
export type { FinalSubmitApproval };

export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;

export interface HumanPrincipal {
  subject: string;
}

export interface ApprovalRecordStore {
  put(claims: ApprovalClaims): void;
  get(approvalId: string): ApprovalClaims | undefined;
  consume(approvalId: string): boolean;
  isConsumed(approvalId: string): boolean;
}

type ApprovalClaims = z.infer<typeof ApprovalClaimsSchema>;

export type ApprovalVerification =
  | { valid: true; approvalId: string; approval: FinalSubmitApproval }
  | { valid: false; reason:
      | "approval_required"
      | "approval_invalid"
      | "approval_expired"
      | "approval_replayed"
      | "approval_not_issued"
      | "approval_signature_invalid"
      | "approval_binding_mismatch"
      | "payload_hash_invalid"
      | "payload_hash_mismatch" };

export interface ApprovalGate {
  verify(input: unknown, expected: ApprovalBinding): ApprovalVerification;
  consume(approvalId: string): boolean;
  isConsumed(approvalId: string): boolean;
}

export interface ApprovalIssuer {
  issue(input: {
    binding: ApprovalBinding;
    principal: unknown;
    expiresAt?: string;
  }): FinalSubmitApproval;
}

export interface ApprovalSystem {
  gate: ApprovalGate;
  issuer: ApprovalIssuer;
}

export interface ApprovalGateOptions {
  signingKey?: Uint8Array;
  now?: () => string;
  records?: ApprovalRecordStore;
}

export interface ApprovalSystemOptions extends ApprovalGateOptions {
  verifyHumanPrincipal: (principal: unknown) => HumanPrincipal | undefined;
  ttlMs?: number;
  idFactory?: () => string;
}

export function createApprovalSystem(options: ApprovalSystemOptions): ApprovalSystem {
  const signingKey = validateSigningKey(options.signingKey ?? randomBytes(32));
  const records = options.records ?? createMemoryApprovalRecordStore();
  const gate = createApprovalGate({
    signingKey,
    records,
    ...(options.now === undefined ? {} : { now: options.now })
  });
  const issuer = createApprovalIssuer({
    signingKey,
    records,
    verifyHumanPrincipal: options.verifyHumanPrincipal,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory })
  });
  return { gate, issuer };
}

export function createApprovalGate(options: ApprovalGateOptions = {}): ApprovalGate {
  const signingKey = validateSigningKey(options.signingKey ?? randomBytes(32));
  const now = options.now ?? (() => new Date().toISOString());
  const records = options.records ?? createMemoryApprovalRecordStore();

  return {
    verify(input, expected) {
      const parsed = FinalSubmitApprovalSchema.safeParse(input);
      if (!parsed.success) return { valid: false, reason: "approval_invalid" };
      const approval = parsed.data;
      const claims = decodeAndVerifyApproval(approval.token, signingKey);
      if (claims === undefined) return { valid: false, reason: "approval_signature_invalid" };
      if (claims.approvalId !== approval.approvalId) {
        return { valid: false, reason: "approval_invalid" };
      }
      const recorded = records.get(claims.approvalId);
      if (recorded === undefined || canonicalJson(recorded) !== canonicalJson(claims)) {
        return { valid: false, reason: "approval_not_issued" };
      }
      if (records.isConsumed(claims.approvalId)) {
        return { valid: false, reason: "approval_replayed" };
      }
      const issuedAt = Date.parse(claims.issuedAt);
      const expiresAt = Date.parse(claims.expiresAt);
      const currentTime = Date.parse(now());
      if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || !Number.isFinite(currentTime)) {
        return { valid: false, reason: "approval_invalid" };
      }
      if (expiresAt <= currentTime) return { valid: false, reason: "approval_expired" };
      if (issuedAt > expiresAt) return { valid: false, reason: "approval_invalid" };
      const mismatch = compareBinding(claims, expected);
      if (mismatch !== undefined) return { valid: false, reason: mismatch };
      return { valid: true, approvalId: approval.approvalId, approval };
    },
    consume(approvalId) {
      return records.consume(approvalId);
    },
    isConsumed(approvalId) {
      return records.isConsumed(approvalId);
    }
  };
}

export function createApprovalIssuer(options: {
  signingKey: Uint8Array;
  records: ApprovalRecordStore;
  verifyHumanPrincipal: (principal: unknown) => HumanPrincipal | undefined;
  now?: () => string;
  ttlMs?: number;
  idFactory?: () => string;
}): ApprovalIssuer {
  const signingKey = validateSigningKey(options.signingKey);
  const now = options.now ?? (() => new Date().toISOString());
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const idFactory = options.idFactory ?? randomUUID;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60_000) {
    throw new Error("human_approval_ttl_invalid");
  }

  return {
    issue(input) {
      const binding = ApprovalBindingSchema.parse(input.binding);
      const principal = options.verifyHumanPrincipal(input.principal);
      if (principal === undefined || typeof principal.subject !== "string" || principal.subject.trim().length === 0) {
        throw new Error("human_approval_principal_invalid");
      }
      const issuedAt = now();
      const issuedAtMs = Date.parse(issuedAt);
      if (!Number.isFinite(issuedAtMs)) throw new Error("human_approval_time_invalid");
      const expiresAt = input.expiresAt ?? new Date(issuedAtMs + ttlMs).toISOString();
      const claims = ApprovalClaimsSchema.parse({
        ...binding,
        approvalId: idFactory(),
        approver: principal.subject.trim(),
        issuedAt,
        expiresAt
      });
      recordsPut(options.records, claims);
      return {
        approvalId: claims.approvalId,
        token: encodeApproval(claims, signingKey)
      };
    }
  };
}

function createMemoryApprovalRecordStore(): ApprovalRecordStore {
  const records = new Map<string, ApprovalClaims>();
  const consumed = new Set<string>();
  return {
    put(claims) {
      records.set(claims.approvalId, cloneClaims(claims));
    },
    get(approvalId) {
      const claims = records.get(approvalId);
      return claims === undefined ? undefined : cloneClaims(claims);
    },
    consume(approvalId) {
      if (!records.has(approvalId) || consumed.has(approvalId)) return false;
      consumed.add(approvalId);
      return true;
    },
    isConsumed(approvalId) {
      return consumed.has(approvalId);
    }
  };
}

function recordsPut(records: ApprovalRecordStore, claims: ApprovalClaims): void {
  if (records.get(claims.approvalId) !== undefined) throw new Error("human_approval_duplicate");
  records.put(claims);
}

function validateSigningKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) {
    throw new Error("approval_signing_key_too_short");
  }
  return key;
}

function encodeApproval(claims: ApprovalClaims, key: Uint8Array): string {
  const body = Buffer.from(canonicalJson(claims), "utf8").toString("base64url");
  return `approval.v1.${body}.${signature(body, key)}`;
}

function decodeAndVerifyApproval(token: string, key: Uint8Array): ApprovalClaims | undefined {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "approval" || parts[1] !== "v1" || !parts[2] || !parts[3]) {
    return undefined;
  }
  const body = parts[2];
  const providedSignature = parts[3];
  const expectedSignature = signature(body, key);
  const expected = Buffer.from(expectedSignature, "base64url");
  const provided = Buffer.from(providedSignature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    const parsed = ApprovalClaimsSchema.safeParse(claims);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function signature(body: string, key: Uint8Array): string {
  return createHmac("sha256", key).update(body, "utf8").digest("base64url");
}

function compareBinding(
  claims: ApprovalClaims,
  expected: ApprovalBinding
): "payload_hash_invalid" | "payload_hash_mismatch" | "approval_binding_mismatch" | undefined {
  if (!HashSchema.safeParse(expected.payloadHash).success) return "payload_hash_invalid";
  if (claims.payloadHash !== expected.payloadHash) return "payload_hash_mismatch";
  const fields: Array<keyof Omit<ApprovalBinding, "payloadHash">> = [
    "runId", "planRevision", "executionEpoch", "snapshotId", "targetFingerprint"
  ];
  return fields.some((field) => claims[field] !== expected[field])
    ? "approval_binding_mismatch"
    : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function cloneClaims(claims: ApprovalClaims): ApprovalClaims {
  return ApprovalClaimsSchema.parse(JSON.parse(JSON.stringify(claims)) as unknown);
}
