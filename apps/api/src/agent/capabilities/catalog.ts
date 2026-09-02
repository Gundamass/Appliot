import { randomUUID } from "node:crypto";
import {
  CapabilityCallerSchema,
  type CapabilityCaller,
  type CapabilityDescriptor,
  JsonValueSchema
} from "@resume/contracts";
import {
  createInvocation,
  type CapabilityContext,
  type CapabilityDefinition
} from "./descriptor.js";
import type {
  InvocationPermitExpected,
  InvocationPermitVerifier
} from "../policy/invocation-permit.js";

export interface CapabilityInvokeContext {
  caller?: CapabilityCaller;
  runId: string;
  executionEpoch: number;
  signal?: AbortSignal;
  idempotencyKey?: string;
  permit?: unknown;
  invocationId?: string;
}

/** The catalog intentionally erases handler input/output generics at its boundary. */
export type AnyCapabilityDefinition = CapabilityDefinition<any, any>;
export type CapabilityDefinitionMetadata = Omit<AnyCapabilityDefinition, "handler">;

export interface CapabilityCatalog {
  names(): readonly string[];
  get(name: string): CapabilityDefinitionMetadata | undefined;
  describe(name: string): CapabilityDescriptor | undefined;
  invoke(name: string, input: unknown, context: CapabilityInvokeContext): Promise<unknown>;
}

const MAX_IDEMPOTENCY_RESULTS = 1_000;
const permitVerifiers = new WeakMap<object, InvocationPermitVerifier>();

export function bindCapabilityCatalogPolicy(
  catalog: CapabilityCatalog,
  verifier: InvocationPermitVerifier
): void {
  const current = permitVerifiers.get(catalog);
  if (current !== undefined) {
    if (current !== verifier) throw new Error("capability_policy_already_bound");
    return;
  }
  permitVerifiers.set(catalog, verifier);
}

export function createCapabilityCatalog(
  definitions: readonly AnyCapabilityDefinition[],
  options: { permitVerifier?: InvocationPermitVerifier } = {}
): CapabilityCatalog {
  const byName = new Map<string, AnyCapabilityDefinition>();
  for (const definition of definitions) {
    if (byName.has(definition.descriptor.name)) {
      throw new Error(`capability_duplicate:${definition.descriptor.name}`);
    }
    byName.set(definition.descriptor.name, definition);
  }
  const idempotencyResults = new Map<string, {
    inputFingerprint: string;
    operation: Promise<unknown>;
  }>();

  const invoke = async (name: string, input: unknown, context: CapabilityInvokeContext): Promise<unknown> => {
    const definition = byName.get(name);
    if (definition === undefined) throw new Error("capability_not_found");
    const caller = CapabilityCallerSchema.safeParse(context.caller ?? "graph");
    if (!caller.success || !definition.descriptor.allowedCallers.includes(caller.data)) {
      throw new Error("capability_caller_not_allowed");
    }
    if (!Number.isInteger(context.executionEpoch) || context.executionEpoch < 0) {
      throw new Error("capability_execution_epoch_invalid");
    }
    const parsedInput = definition.inputSchema.safeParse(input);
    if (!parsedInput.success) throw new Error("capability_input_invalid");
    const jsonInput = JsonValueSchema.safeParse(parsedInput.data);
    if (!jsonInput.success) throw new Error("capability_input_invalid");
    const rawContext = context as CapabilityInvokeContext & { approval?: unknown };
    if (rawContext.approval !== undefined) throw new Error("capability_approval_credential_forbidden");
    const verifier = permitVerifiers.get(catalog);
    if (verifier === undefined) throw new Error("capability_policy_required");
    const expected: InvocationPermitExpected = {
      capability: definition.descriptor.name,
      version: definition.descriptor.version,
      caller: caller.data,
      runId: context.runId,
      executionEpoch: context.executionEpoch,
      input: jsonInput.data,
      ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey })
    };
    const verified = verifier.verifyAndConsume(context.permit, expected);
    if (!verified.valid) {
      const reason = verified.reason === "permit_binding_mismatch"
        ? "capability_authorization_mismatch"
        : `capability_${verified.reason}`;
      throw new Error(reason);
    }
    const invocation = createInvocation(definition, jsonInput.data, {
      caller: caller.data,
      runId: context.runId,
      ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
      invocationId: verified.invocationId
    });
    const idempotencyKey = definition.descriptor.idempotency === "keyed"
      ? invocation.idempotencyKey
      : undefined;
    if (definition.descriptor.idempotency === "keyed" && idempotencyKey === undefined) {
      throw new Error("capability_idempotency_key_required");
    }
    const cacheKey = idempotencyKey === undefined
      ? undefined
      : `${invocation.runId}\u0000${invocation.caller}\u0000${context.executionEpoch}\u0000${invocation.capability}\u0000${invocation.version}\u0000${idempotencyKey}`;
    const inputFingerprint = cacheKey === undefined ? undefined : canonicalJson(jsonInput.data);
    if (cacheKey !== undefined) {
      const existing = idempotencyResults.get(cacheKey);
      if (existing !== undefined) {
        if (existing.inputFingerprint !== inputFingerprint) {
          throw new Error("capability_idempotency_conflict");
        }
        return existing.operation;
      }
    }

    const operation = invokeWithTimeout(definition, parsedInput.data, {
      invocationId: invocation.invocationId,
      caller: invocation.caller,
      runId: invocation.runId,
      executionEpoch: context.executionEpoch,
      signal: context.signal ?? new AbortController().signal,
      ...(invocation.idempotencyKey === undefined ? {} : { idempotencyKey: invocation.idempotencyKey }),
    });
    if (cacheKey !== undefined) {
      if (idempotencyResults.size >= MAX_IDEMPOTENCY_RESULTS) {
        const oldest = idempotencyResults.keys().next().value as string | undefined;
        if (oldest !== undefined) idempotencyResults.delete(oldest);
      }
      idempotencyResults.set(cacheKey, { inputFingerprint: inputFingerprint!, operation });
    }
    return operation;
  };

  const catalog = Object.freeze({
    names: () => Object.freeze([...byName.keys()]),
    get: (name: string) => {
      const definition = byName.get(name);
      if (definition === undefined) return undefined;
      const { handler: _handler, ...metadata } = definition;
      return metadata;
    },
    describe: (name: string) => byName.get(name)?.descriptor,
    invoke
  });
  if (options.permitVerifier !== undefined) bindCapabilityCatalogPolicy(catalog, options.permitVerifier);
  return catalog;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function invokeWithTimeout(
  definition: AnyCapabilityDefinition,
  input: unknown,
  context: CapabilityContext
): Promise<unknown> {
  const controller = new AbortController();
  let rejectAbort!: (reason?: unknown) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = (): void => {
    if (!controller.signal.aborted) controller.abort(context.signal.reason);
    rejectAbort(new Error("capability_cancelled"));
  };
  if (context.signal.aborted) onAbort();
  else context.signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  let rejectTimeout!: (reason?: unknown) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort("capability_timeout");
    rejectTimeout(new Error("capability_timeout"));
  }, definition.descriptor.timeoutMs);
  try {
    const operation = Promise.resolve().then(() => definition.handler(input, { ...context, signal: controller.signal }));
    const result = await Promise.race([operation, timeout, cancellation]);
    if (timedOut) throw new Error("capability_timeout");
    if (context.signal.aborted) throw new Error("capability_cancelled");
    const parsedOutput = definition.outputSchema.safeParse(result);
    if (!parsedOutput.success) throw new Error("capability_output_invalid");
    return parsedOutput.data;
  } catch (error) {
    if (timedOut) throw new Error("capability_timeout");
    if (context.signal.aborted) throw new Error("capability_cancelled");
    if (error instanceof Error && /^capability_/u.test(error.message)) throw error;
    throw error;
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", onAbort);
  }
}
