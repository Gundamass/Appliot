import { z } from "zod";
import { defineCapability, type CapabilityDefinition, type CapabilityHandler } from "../descriptor.js";

export interface CoreCapabilityHandlers {
  readonly read?: CapabilityHandler;
  readonly transform?: CapabilityHandler;
  readonly reversibleAct?: CapabilityHandler;
  readonly irreversibleAct?: CapabilityHandler;
}

/**
 * A small, explicit starter catalog. Production composition supplies the
 * handlers; no handler is invented or granted browser access by default.
 */
export function createCoreCapabilityDefinitions(
  handlers: CoreCapabilityHandlers = {}
): CapabilityDefinition[] {
  const definitions: CapabilityDefinition[] = [];
  if (handlers.read !== undefined) {
    definitions.push(defineCapability({
      descriptor: {
        name: "data.read",
        version: "1.0.0",
        kind: "read",
        risk: "low",
        sideEffect: "none",
        allowedCallers: ["supervisor", "specialist_agent", "graph"],
        requiresApproval: false,
        idempotency: "idempotent",
        timeoutMs: 10_000
      },
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      handler: handlers.read
    }));
  }
  if (handlers.transform !== undefined) {
    definitions.push(defineCapability({
      descriptor: {
        name: "data.transform",
        version: "1.0.0",
        kind: "transform",
        risk: "low",
        sideEffect: "none",
        allowedCallers: ["supervisor", "specialist_agent", "graph"],
        requiresApproval: false,
        idempotency: "idempotent",
        timeoutMs: 30_000
      },
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      handler: handlers.transform
    }));
  }
  if (handlers.reversibleAct !== undefined) {
    definitions.push(defineCapability({
      descriptor: {
        name: "application.reversible_act",
        version: "1.0.0",
        kind: "act",
        risk: "high",
        sideEffect: "reversible",
        allowedCallers: ["graph", "specialist_agent"],
        requiresApproval: true,
        idempotency: "keyed",
        timeoutMs: 60_000
      },
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      handler: handlers.reversibleAct
    }));
  }
  if (handlers.irreversibleAct !== undefined) {
    definitions.push(defineCapability({
      descriptor: {
        name: "final_submit",
        version: "1.0.0",
        kind: "act",
        risk: "irreversible",
        sideEffect: "external",
        allowedCallers: ["graph"],
        requiresApproval: true,
        idempotency: "none",
        timeoutMs: 60_000
      },
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      handler: handlers.irreversibleAct
    }));
  }
  return definitions;
}
