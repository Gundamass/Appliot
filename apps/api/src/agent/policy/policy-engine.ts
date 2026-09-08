import { createHash } from "node:crypto";
import {
  CapabilityCallerSchema,
  JsonValueSchema,
  type CapabilityCaller,
  type CapabilityDescriptor
} from "@resume/contracts";
import { bindCapabilityCatalogPolicy, type CapabilityCatalog } from "../capabilities/catalog.js";
import type { ApprovalBinding, ApprovalGate } from "./approval-gate.js";
import { createInjectionDetector, type InjectionDetection, type InjectionDetector } from "./injection-detector.js";
import {
  createInvocationPermitAuthority,
  type InvocationPermitAuthority
} from "./invocation-permit.js";
import type { CallerAttestationVerifier } from "./caller-attestation.js";
import { createRiskClassifier, type RiskClassification, type RiskClassifier } from "./risk-classifier.js";

export interface PolicyAuthorizeInput {
  caller: CapabilityCaller;
  capability: string;
  input: unknown;
  context?: {
    runId?: string;
    planRevision?: number;
    executionEpoch?: number;
    snapshotId?: string;
    targetFingerprint?: string;
    payloadHash?: string;
    callerAttestation?: unknown;
    approval?: unknown;
    signal?: AbortSignal;
    idempotencyKey?: string;
  };
}

export type PolicyDenyReason =
  | "capability_not_found"
  | "caller_not_allowed"
  | "capability_input_invalid"
  | "capability_idempotency_key_required"
  | "approval_required"
  | "approval_invalid"
  | "approval_expired"
  | "approval_replayed"
  | "approval_not_issued"
  | "approval_signature_invalid"
  | "approver_not_human"
  | "payload_hash_invalid"
  | "payload_hash_mismatch"
  | "approval_binding_mismatch"
  | "caller_attestation_required"
  | "caller_attestation_invalid"
  | "caller_attestation_expired"
  | "caller_attestation_mismatch"
  | "prompt_injection_detected"
  | "policy_blocked";

export type PolicyDecision =
  | {
      allowed: true;
      descriptor: CapabilityDescriptor;
      risk: RiskClassification;
      input: unknown;
      approvalId?: string;
      permit: string;
    }
  | {
      allowed: false;
      reason: PolicyDenyReason;
      descriptor?: CapabilityDescriptor;
      risk?: RiskClassification;
      injection?: InjectionDetection;
    };

export interface PolicyEngine {
  authorize(input: PolicyAuthorizeInput): Promise<PolicyDecision>;
}

export interface PolicyEngineDependencies {
  catalog: CapabilityCatalog;
  approvalGate: ApprovalGate;
  permitAuthority?: InvocationPermitAuthority;
  callerAttestationVerifier?: CallerAttestationVerifier;
  riskClassifier?: RiskClassifier;
  injectionDetector?: InjectionDetector;
}

export function createPolicyEngine(dependencies: PolicyEngineDependencies): PolicyEngine {
  const riskClassifier = dependencies.riskClassifier ?? createRiskClassifier();
  const injectionDetector = dependencies.injectionDetector ?? createInjectionDetector();
  const permitAuthority = dependencies.permitAuthority ?? createInvocationPermitAuthority();
  bindCapabilityCatalogPolicy(
    dependencies.catalog,
    permitAuthority.verifier,
    dependencies.callerAttestationVerifier
  );

  return {
    async authorize(request) {
      const descriptor = dependencies.catalog.describe(request.capability);
      if (descriptor === undefined) return { allowed: false, reason: "capability_not_found" };
      if (dependencies.callerAttestationVerifier === undefined) {
        return { allowed: false, reason: "caller_attestation_required", descriptor };
      }
      const callerVerification = dependencies.callerAttestationVerifier.verify(request.context?.callerAttestation);
      if (!callerVerification.valid) {
        return { allowed: false, reason: callerVerification.reason, descriptor };
      }
      if (typeof request.context?.callerAttestation !== "string") {
        return { allowed: false, reason: "caller_attestation_invalid", descriptor };
      }
      const caller = CapabilityCallerSchema.safeParse(request.caller);
      if (!caller.success || caller.data !== callerVerification.caller) {
        return { allowed: false, reason: "caller_attestation_mismatch", descriptor };
      }
      if (!descriptor.allowedCallers.includes(callerVerification.caller)) {
        return { allowed: false, reason: "caller_not_allowed", descriptor };
      }
      const definition = dependencies.catalog.get(request.capability);
      if (definition === undefined) return { allowed: false, reason: "capability_not_found" };
      const parsedInput = definition.inputSchema.safeParse(request.input);
      if (!parsedInput.success || !JsonValueSchema.safeParse(parsedInput.data).success) {
        const injection = detectExternalInjection(request.input, injectionDetector);
        if (injection?.detected === true) {
          return { allowed: false, reason: "prompt_injection_detected", descriptor, injection };
        }
        return { allowed: false, reason: "capability_input_invalid", descriptor };
      }
      const injection = detectExternalInjection(parsedInput.data, injectionDetector);
      if (injection?.detected === true) {
        return { allowed: false, reason: "prompt_injection_detected", descriptor, injection };
      }
      const actualPayloadHash = hashCapabilityPayload(jsonValue(parsedInput.data));
      const declaredPayloadHash = readRecord(parsedInput.data)?.payloadHash;
      if (declaredPayloadHash !== undefined && !isHash(declaredPayloadHash)) {
        return { allowed: false, reason: "payload_hash_invalid", descriptor };
      }
      if (declaredPayloadHash !== undefined && declaredPayloadHash.toLowerCase() !== actualPayloadHash) {
        return { allowed: false, reason: "payload_hash_mismatch", descriptor };
      }
      if (request.context?.payloadHash !== undefined && !isHash(request.context.payloadHash)) {
        return { allowed: false, reason: "payload_hash_invalid", descriptor };
      }
      if (request.context?.payloadHash !== undefined
        && request.context.payloadHash.toLowerCase() !== actualPayloadHash) {
        return { allowed: false, reason: "payload_hash_mismatch", descriptor };
      }
      const embeddedPayloadHash = readExpected(readRecord(parsedInput.data)?.expected).payloadHash;
      if (embeddedPayloadHash !== undefined && !isHash(embeddedPayloadHash)) {
        return { allowed: false, reason: "payload_hash_invalid", descriptor };
      }
      if (embeddedPayloadHash !== undefined && embeddedPayloadHash.toLowerCase() !== actualPayloadHash) {
        return { allowed: false, reason: "payload_hash_mismatch", descriptor };
      }
      if (descriptor.idempotency === "keyed" && !isValidIdempotencyKey(request.context?.idempotencyKey)) {
        return { allowed: false, reason: "capability_idempotency_key_required", descriptor };
      }
      const risk = injection === undefined
        ? riskClassifier.classify({ descriptor, value: parsedInput.data })
        : riskClassifier.classify({ descriptor, value: parsedInput.data, injection });
      if (risk.risk === "irreversible" && request.caller !== "graph") {
        return { allowed: false, reason: "caller_not_allowed", descriptor, risk };
      }
      let approvalId: string | undefined;
      let onConsume: (() => boolean) | undefined;
      if (risk.requiresApproval) {
        const binding = bindingFrom(request, parsedInput.data, actualPayloadHash);
        const approval = request.context?.approval ?? readRecord(parsedInput.data)?.approval;
        if (approval === undefined) return { allowed: false, reason: "approval_required", descriptor, risk };
        if (!hasCompleteBinding(binding)) {
          return { allowed: false, reason: "approval_binding_mismatch", descriptor, risk };
        }
        const verification = dependencies.approvalGate.verify(approval, binding as ApprovalBinding);
        if (!verification.valid) {
          return { allowed: false, reason: verification.reason, descriptor, risk };
        }
        approvalId = verification.approvalId;
        onConsume = () => dependencies.approvalGate.consume(verification.approvalId);
      }

      const permit = permitAuthority.issuer.issue({
        capability: descriptor.name,
        version: descriptor.version,
        caller: request.caller,
        runId: request.context?.runId ?? "run-unknown",
        executionEpoch: request.context?.executionEpoch ?? 0,
        input: parsedInput.data,
        callerAttestation: request.context?.callerAttestation as string,
        ...(request.context?.idempotencyKey === undefined ? {} : { idempotencyKey: request.context.idempotencyKey }),
        ...(onConsume === undefined ? {} : { onConsume })
      });
      return {
        allowed: true,
        descriptor,
        risk,
        input: parsedInput.data,
        permit,
        ...(approvalId === undefined ? {} : { approvalId })
      };
    }
  };
}

function isValidIdempotencyKey(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= 256;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readExpected(value: unknown): Partial<ApprovalBinding> {
  const record = readRecord(value);
  if (record === undefined) return {};
  const expected: Partial<ApprovalBinding> = {};
  if (typeof record.runId === "string") expected.runId = record.runId;
  if (typeof record.planRevision === "number") expected.planRevision = record.planRevision;
  if (typeof record.executionEpoch === "number") expected.executionEpoch = record.executionEpoch;
  if (typeof record.snapshotId === "string") expected.snapshotId = record.snapshotId;
  if (typeof record.targetFingerprint === "string") expected.targetFingerprint = record.targetFingerprint;
  if (typeof record.payloadHash === "string") expected.payloadHash = record.payloadHash;
  return expected;
}

function bindingFrom(request: PolicyAuthorizeInput, input: unknown, actualPayloadHash: string): Partial<ApprovalBinding> {
  const record = readRecord(input);
  const context = request.context;
  const embedded = readExpected(record?.expected);
  const binding: Partial<ApprovalBinding> = {};
  const runId = context?.runId ?? embedded.runId;
  const planRevision = context?.planRevision ?? embedded.planRevision;
  const executionEpoch = context?.executionEpoch ?? embedded.executionEpoch;
  const snapshotId = context?.snapshotId ?? embedded.snapshotId;
  const targetFingerprint = context?.targetFingerprint ?? embedded.targetFingerprint;
  const payloadHash = actualPayloadHash;
  if (runId !== undefined) binding.runId = runId;
  if (planRevision !== undefined) binding.planRevision = planRevision;
  if (executionEpoch !== undefined) binding.executionEpoch = executionEpoch;
  if (snapshotId !== undefined) binding.snapshotId = snapshotId;
  if (targetFingerprint !== undefined) binding.targetFingerprint = targetFingerprint;
  if (payloadHash !== undefined) binding.payloadHash = payloadHash;
  return binding;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

function jsonValue(value: unknown): import("@resume/contracts").JsonValue {
  return JsonValueSchema.parse(value);
}

export function hashCapabilityPayload(value: import("@resume/contracts").JsonValue): string {
  return createHash("sha256").update(canonicalJson(payloadWithoutAuthorizationMetadata(value)), "utf8").digest("hex");
}

function payloadWithoutAuthorizationMetadata(value: import("@resume/contracts").JsonValue): import("@resume/contracts").JsonValue {
  if (Array.isArray(value)) return value.map(payloadWithoutAuthorizationMetadata);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, import("@resume/contracts").JsonValue>;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "payloadHash" && key !== "approval" && key !== "expected")
      .map(([key, nested]) => [key, payloadWithoutAuthorizationMetadata(nested)])
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function hasCompleteBinding(binding: Partial<ApprovalBinding>): boolean {
  return binding.runId !== undefined
    && binding.planRevision !== undefined
    && binding.executionEpoch !== undefined
    && binding.snapshotId !== undefined
    && binding.targetFingerprint !== undefined
    && binding.payloadHash !== undefined;
}

function detectExternalInjection(value: unknown, detector: InjectionDetector): InjectionDetection | undefined {
  const findings: InjectionDetection[] = [];
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      findings.push(detector.detect(candidate));
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    const record = readRecord(candidate);
    if (record === undefined) return;
    Object.values(record).forEach(visit);
  };
  visit(value);
  const detected = findings.filter((finding) => finding.detected);
  if (detected.length > 0) {
    const first = detected[0]!;
    return {
      ...first,
      signals: [...new Set(detected.flatMap((finding) => finding.signals))],
      score: Math.min(1, detected.reduce((total, finding) => total + finding.score, 0))
    };
  }
  return findings[0];
}
