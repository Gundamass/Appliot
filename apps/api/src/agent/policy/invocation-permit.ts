import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CapabilityCallerSchema,
  JsonValueSchema,
  type CapabilityCaller,
  type JsonValue
} from "@resume/contracts";
import { z } from "zod";

const PermitClaimsSchema = z.object({
  permitId: z.string().min(1).max(128),
  invocationId: z.string().min(1).max(128),
  capability: z.string().min(1).max(128),
  version: z.string().min(1).max(32),
  caller: CapabilityCallerSchema,
  runId: z.string().min(1).max(128),
  executionEpoch: z.number().int().nonnegative(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
  callerAttestationHash: z.string().regex(/^[a-f0-9]{64}$/u),
  idempotencyKey: z.string().min(1).max(256).optional(),
  expiresAt: z.number().int().positive()
}).strict();

type PermitClaims = z.infer<typeof PermitClaimsSchema>;

export interface InvocationPermitRequest {
  capability: string;
  version: string;
  caller: CapabilityCaller;
  runId: string;
  executionEpoch: number;
  input: JsonValue;
  callerAttestation: string;
  idempotencyKey?: string;
  onConsume?: () => boolean;
}

export interface InvocationPermitExpected {
  capability: string;
  version: string;
  caller: CapabilityCaller;
  runId: string;
  executionEpoch: number;
  input: JsonValue;
  callerAttestation: string;
  idempotencyKey?: string;
}

export type InvocationPermitVerification =
  | { valid: true; permitId: string; invocationId: string; approvalId?: string }
  | { valid: false; reason:
      | "permit_required"
      | "permit_invalid"
      | "permit_not_issued"
      | "permit_expired"
      | "permit_replayed"
      | "permit_binding_mismatch"
      | "approval_replayed" };

export interface InvocationPermitIssuer {
  issue(input: InvocationPermitRequest): string;
}

export interface InvocationPermitVerifier {
  verifyAndConsume(token: unknown, expected: InvocationPermitExpected): InvocationPermitVerification;
}

export interface InvocationPermitAuthority {
  issuer: InvocationPermitIssuer;
  verifier: InvocationPermitVerifier;
}

export function createInvocationPermitAuthority(options: {
  signingKey?: Uint8Array;
  now?: () => number;
  ttlMs?: number;
  idFactory?: () => string;
} = {}): InvocationPermitAuthority {
  const signingKey = validateSigningKey(options.signingKey ?? randomBytes(32));
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60_000;
  const idFactory = options.idFactory ?? randomUUID;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60_000) {
    throw new Error("invocation_permit_ttl_invalid");
  }

  const pending = new Map<string, { claims: PermitClaims; onConsume?: () => boolean; consumed: boolean }>();

  const issuer: InvocationPermitIssuer = {
    issue(input) {
      const parsedInput = JsonValueSchema.parse(input.input);
      const claims = PermitClaimsSchema.parse({
        permitId: idFactory(),
        invocationId: `invocation:${idFactory()}`,
        capability: input.capability,
        version: input.version,
        caller: input.caller,
        runId: input.runId,
        executionEpoch: input.executionEpoch,
        inputHash: hashJson(parsedInput),
        callerAttestationHash: hashString(input.callerAttestation),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        expiresAt: now() + ttlMs
      });
      pending.set(claims.permitId, {
        claims,
        ...(input.onConsume === undefined ? {} : { onConsume: input.onConsume }),
        consumed: false
      });
      return encodePermit(claims, signingKey);
    }
  };

  const verifier: InvocationPermitVerifier = {
    verifyAndConsume(token, expected) {
      if (token === undefined) return { valid: false, reason: "permit_required" };
      const claims = decodePermit(token, signingKey);
      if (claims === undefined) return { valid: false, reason: "permit_invalid" };
      const entry = pending.get(claims.permitId);
      if (entry === undefined) return { valid: false, reason: "permit_not_issued" };
      if (entry.consumed) return { valid: false, reason: "permit_replayed" };
      if (claims.expiresAt <= now()) return { valid: false, reason: "permit_expired" };
      if (!sameExpected(claims, expected)) return { valid: false, reason: "permit_binding_mismatch" };
      if (entry.onConsume !== undefined && !entry.onConsume()) {
        entry.consumed = true;
        return { valid: false, reason: "approval_replayed" };
      }
      entry.consumed = true;
      return {
        valid: true,
        permitId: claims.permitId,
        invocationId: claims.invocationId
      };
    }
  };

  return { issuer, verifier };
}

function validateSigningKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) {
    throw new Error("invocation_permit_signing_key_too_short");
  }
  return key;
}

function encodePermit(claims: PermitClaims, key: Uint8Array): string {
  const body = Buffer.from(canonicalJson(claims), "utf8").toString("base64url");
  return `permit.v1.${body}.${signature(body, key)}`;
}

function decodePermit(token: unknown, key: Uint8Array): PermitClaims | undefined {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "permit" || parts[1] !== "v1" || !parts[2] || !parts[3]) {
    return undefined;
  }
  const body = parts[2];
  const providedSignature = parts[3];
  const expectedSignature = signature(body, key);
  const expected = Buffer.from(expectedSignature, "base64url");
  const provided = Buffer.from(providedSignature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined;
  try {
    const parsed = PermitClaimsSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function sameExpected(claims: PermitClaims, expected: InvocationPermitExpected): boolean {
  return claims.capability === expected.capability
    && claims.version === expected.version
    && claims.caller === expected.caller
    && claims.runId === expected.runId
    && claims.executionEpoch === expected.executionEpoch
    && claims.inputHash === hashJson(expected.input)
    && claims.callerAttestationHash === hashString(expected.callerAttestation)
    && claims.idempotencyKey === expected.idempotencyKey;
}

function hashJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function hashString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function signature(body: string, key: Uint8Array): string {
  return createHmac("sha256", key).update(body, "utf8").digest("base64url");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
