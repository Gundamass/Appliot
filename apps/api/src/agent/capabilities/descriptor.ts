import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CapabilityDescriptorSchema,
  type CapabilityCaller,
  type CapabilityDescriptor,
  type CapabilityInvocation,
  CapabilityInvocationSchema,
  type JsonValue
} from "@resume/contracts";

export interface CapabilityContext {
  readonly invocationId: string;
  readonly caller: CapabilityCaller;
  readonly runId: string;
  readonly executionEpoch: number;
  readonly signal: AbortSignal;
  readonly idempotencyKey?: string;
}

export type CapabilityHandler<Input = unknown, Output = unknown> =
  (input: Input, context: CapabilityContext) => Output | Promise<Output>;

export interface CapabilityDefinition<Input = unknown, Output = unknown> {
  readonly descriptor: CapabilityDescriptor;
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  readonly handler: CapabilityHandler<Input, Output>;
}

export interface DefineCapabilityInput<Input, Output> {
  descriptor: CapabilityDescriptor;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  handler: CapabilityHandler<Input, Output>;
}

export function defineCapability<Input, Output>(
  definition: DefineCapabilityInput<Input, Output>
): CapabilityDefinition<Input, Output> {
  const descriptor = deepFreeze(CapabilityDescriptorSchema.parse(definition.descriptor));
  return Object.freeze({
    descriptor,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    handler: definition.handler
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}

export function createInvocation(
  definition: CapabilityDefinition,
  input: JsonValue,
  context: Pick<CapabilityContext, "caller" | "runId" | "idempotencyKey"> & { invocationId?: string }
): CapabilityInvocation {
  return CapabilityInvocationSchema.parse({
    invocationId: context.invocationId ?? `invocation:${randomUUID()}`,
    capability: definition.descriptor.name,
    version: definition.descriptor.version,
    caller: context.caller,
    runId: context.runId,
    input,
    ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey })
  });
}
