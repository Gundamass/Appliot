import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ExecutableCommand, FormSnapshot } from "@resume/contracts";
import type { ApprovalStore } from "./approval-store.js";

export type ApprovalOperation = ExecutableCommand["type"];

export interface ApprovalRequest {
  taskId: string;
  snapshotId: string;
  targetId: string;
  operation: ApprovalOperation;
}

export interface ActionApproval extends ApprovalRequest {
  token: string;
  expiresAt: number;
  oneUse: true;
}

interface ApprovalPayload extends ApprovalRequest {
  id: string;
  expiresAt: number;
}

interface PolicyOptions {
  now?: () => number;
  ttlMs?: number;
}

export class PolicyDeniedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PolicyDeniedError";
  }
}

export class ActionPolicy {
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly key: Uint8Array, options: PolicyOptions = {}) {
    if (key.byteLength < 32) throw new PolicyDeniedError("approval_key_too_short");
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  approve(
    request: ApprovalRequest,
    snapshot: FormSnapshot,
    validation: { valid: boolean } = { valid: true }
  ): ActionApproval {
    validateRequestContext(request, snapshot);
    validateTargetAndOperation(request, snapshot, validation);
    const payload: ApprovalPayload = {
      id: randomUUID(),
      taskId: request.taskId,
      snapshotId: request.snapshotId,
      targetId: request.targetId,
      operation: request.operation,
      expiresAt: this.now() + this.ttlMs
    };
    return {
      ...request,
      token: encodeToken(payload, this.key),
      expiresAt: payload.expiresAt,
      oneUse: true
    };
  }
}

export function verifyAndConsumeApproval(
  command: ExecutableCommand,
  key: Uint8Array,
  store: ApprovalStore,
  options: Pick<PolicyOptions, "now"> = {}
): ApprovalPayload {
  const payload = decodeAndVerifyToken(command.approval, key);
  const expected = commandBinding(command);
  if (payload.taskId !== command.taskId) throw new PolicyDeniedError("approval_task_mismatch");
  if (payload.snapshotId !== command.snapshotId) throw new PolicyDeniedError("approval_snapshot_mismatch");
  if (payload.targetId !== expected.targetId) throw new PolicyDeniedError("approval_target_mismatch");
  if (payload.operation !== expected.operation) throw new PolicyDeniedError("approval_operation_mismatch");
  if (payload.expiresAt < (options.now ?? Date.now)()) throw new PolicyDeniedError("approval_expired");
  if (!store.consume(payload.id)) throw new PolicyDeniedError("approval_replayed");
  return payload;
}

function validateRequestContext(request: ApprovalRequest, snapshot: FormSnapshot): void {
  if (snapshot.taskId !== request.taskId) throw new PolicyDeniedError("task_mismatch");
  if (snapshot.id !== request.snapshotId) throw new PolicyDeniedError("stale_snapshot");
}

function validateTargetAndOperation(
  request: ApprovalRequest,
  snapshot: FormSnapshot,
  validation: { valid: boolean }
): void {
  if (request.operation === "click_intermediate") {
    const action = snapshot.actions.find((candidate) => candidate.id === request.targetId);
    if (!action) throw new PolicyDeniedError("action_not_found");
    if (action.class === "terminal_submit") throw new PolicyDeniedError("terminal_submit_denied");
    if (action.class === "unknown_side_effect") throw new PolicyDeniedError("unknown_side_effect_denied");
    if (action.class !== "intermediate_navigation" && action.class !== "intermediate_save") {
      throw new PolicyDeniedError("action_not_intermediate");
    }
    if (!validation.valid) throw new PolicyDeniedError("page_not_valid");
    return;
  }

  const field = snapshot.fields.find((candidate) => candidate.id === request.targetId);
  if (!field) throw new PolicyDeniedError("field_not_found");
  if (request.operation === "select" && field.type !== "select" && field.type !== "radio") {
    throw new PolicyDeniedError("field_operation_mismatch");
  }
  if (request.operation === "upload" && field.type !== "file") {
    throw new PolicyDeniedError("field_operation_mismatch");
  }
  if (request.operation === "fill" && ["select", "radio", "file"].includes(field.type)) {
    throw new PolicyDeniedError("field_operation_mismatch");
  }
}

function commandBinding(command: ExecutableCommand): { operation: ApprovalOperation; targetId: string } {
  if (command.type === "click_intermediate") return { operation: command.type, targetId: command.actionId };
  return { operation: command.type, targetId: command.fieldId };
}

function encodeToken(payload: ApprovalPayload, key: Uint8Array): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signature(body, key)}`;
}

function decodeAndVerifyToken(token: string, key: Uint8Array): ApprovalPayload {
  const [body, providedSignature, extra] = token.split(".");
  if (!body || !providedSignature || extra !== undefined) throw new PolicyDeniedError("approval_malformed");
  const expected = Buffer.from(signature(body, key), "base64url");
  const provided = Buffer.from(providedSignature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new PolicyDeniedError("approval_signature_invalid");
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<ApprovalPayload>;
    if (
      typeof payload.id !== "string"
      || typeof payload.taskId !== "string"
      || typeof payload.snapshotId !== "string"
      || typeof payload.targetId !== "string"
      || !["fill", "select", "upload", "click_intermediate"].includes(payload.operation ?? "")
      || typeof payload.expiresAt !== "number"
    ) throw new Error("invalid payload");
    return payload as ApprovalPayload;
  } catch {
    throw new PolicyDeniedError("approval_malformed");
  }
}

function signature(body: string, key: Uint8Array): string {
  return createHmac("sha256", key).update(body, "utf8").digest("base64url");
}
