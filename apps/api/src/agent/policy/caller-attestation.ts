import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CapabilityCallerSchema,
  type CapabilityCaller
} from "@resume/contracts";
import { z } from "zod";

const AttestationClaimsSchema = z.object({
  attestationId: z.string().min(1).max(128),
  caller: CapabilityCallerSchema,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive()
}).strict();

type AttestationClaims = z.infer<typeof AttestationClaimsSchema>;

declare const callerAttestationTokenBrand: unique symbol;

/**
 * An attestation is an opaque capability. Only the composition root should
 * obtain one from the issuer; downstream agents receive an already-scoped
 * token and cannot choose a different caller identity.
 */
export type CallerAttestationToken = string & {
  readonly [callerAttestationTokenBrand]: "CallerAttestationToken";
};

export interface CallerAttestationTokens {
  readonly graph: CallerAttestationToken;
  readonly runtime: CallerAttestationToken;
  readonly supervisor: CallerAttestationToken;
  readonly specialistAgent: CallerAttestationToken;
}

export interface CallerAttestationIssuer {
  /**
   * This issuer belongs at the composition root. It must never be exposed to
   * model-generated input or to an untrusted capability handler.
   */
  issue(caller: CapabilityCaller): CallerAttestationToken;
}

/**
 * Trusted composition boundary for dynamic, per-run attestation issuance.
 * Callers should request a fresh token when a graph/runtime/supervisor
 * invocation starts instead of retaining a process-start token.
 */
export interface CallerAttestationProvider {
  issue(caller: CapabilityCaller): CallerAttestationToken;
  readonly graph: () => CallerAttestationToken;
  readonly runtime: () => CallerAttestationToken;
  readonly supervisor: () => CallerAttestationToken;
  readonly specialistAgent: () => CallerAttestationToken;
}

export type CallerAttestationVerification =
  | { valid: true; caller: CapabilityCaller; attestationId: string }
  | { valid: false; reason: "caller_attestation_required" | "caller_attestation_invalid" | "caller_attestation_expired" };

export interface CallerAttestationVerifier {
  verify(token: unknown): CallerAttestationVerification;
}

export interface CallerAttestationAuthority {
  issuer: CallerAttestationIssuer;
  verifier: CallerAttestationVerifier;
}

/**
 * Build the fixed set of identities used by the agent runtime. Keeping this
 * in the trusted composition root prevents a model or specialist from
 * minting a token for another execution boundary.
 */
export function issueCallerAttestationTokens(
  issuer: CallerAttestationIssuer
): CallerAttestationTokens {
  return Object.freeze({
    graph: issuer.issue("graph"),
    runtime: issuer.issue("runtime"),
    supervisor: issuer.issue("supervisor"),
    specialistAgent: issuer.issue("specialist_agent")
  });
}

export function createCallerAttestationProvider(
  issuer: CallerAttestationIssuer
): CallerAttestationProvider {
  return Object.freeze({
    issue: (caller: CapabilityCaller) => issuer.issue(caller),
    graph: () => issuer.issue("graph"),
    runtime: () => issuer.issue("runtime"),
    supervisor: () => issuer.issue("supervisor"),
    specialistAgent: () => issuer.issue("specialist_agent")
  });
}

export function createCallerAttestationAuthority(options: {
  signingKey?: Uint8Array;
  now?: () => number;
  ttlMs?: number;
  idFactory?: () => string;
} = {}): CallerAttestationAuthority {
  const signingKey = validateSigningKey(options.signingKey ?? randomBytes(32));
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const idFactory = options.idFactory ?? randomUUID;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60_000) {
    throw new Error("caller_attestation_ttl_invalid");
  }

  const issuer: CallerAttestationIssuer = {
    issue(caller) {
      const issuedAt = now();
      const claims = AttestationClaimsSchema.parse({
        attestationId: idFactory(),
        caller,
        issuedAt,
        expiresAt: issuedAt + ttlMs
      });
      return encodeAttestation(claims, signingKey);
    }
  };

  const verifier: CallerAttestationVerifier = {
    verify(token) {
      if (token === undefined) return { valid: false, reason: "caller_attestation_required" };
      const claims = decodeAttestation(token, signingKey);
      if (claims === undefined) return { valid: false, reason: "caller_attestation_invalid" };
      const currentTime = now();
      if (claims.expiresAt <= currentTime || claims.issuedAt > currentTime) {
        return { valid: false, reason: "caller_attestation_expired" };
      }
      return {
        valid: true,
        caller: claims.caller,
        attestationId: claims.attestationId
      };
    }
  };

  return { issuer, verifier };
}

function validateSigningKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) {
    throw new Error("caller_attestation_signing_key_too_short");
  }
  return new Uint8Array(key);
}

function encodeAttestation(claims: AttestationClaims, key: Uint8Array): CallerAttestationToken {
  const body = Buffer.from(canonicalJson(claims), "utf8").toString("base64url");
  return `caller.v1.${body}.${signature(body, key)}` as CallerAttestationToken;
}

function decodeAttestation(token: unknown, key: Uint8Array): AttestationClaims | undefined {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "caller" || parts[1] !== "v1" || !parts[2] || !parts[3]) {
    return undefined;
  }
  const body = parts[2];
  const providedSignature = parts[3];
  const expectedSignature = signature(body, key);
  const expected = Buffer.from(expectedSignature, "base64url");
  const provided = Buffer.from(providedSignature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined;
  try {
    const parsed = AttestationClaimsSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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
