import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCapabilityCatalog } from "./catalog.js";
import { defineCapability } from "./descriptor.js";
import { createApprovalSystem } from "../policy/approval-gate.js";
import { createCallerAttestationAuthority } from "../policy/caller-attestation.js";
import { createPolicyEngine } from "../policy/policy-engine.js";

const callerAttestations = createCallerAttestationAuthority({
  signingKey: Buffer.alloc(32, 23)
});
const callerTokens = new Map<string, string>();

function context(caller: "graph" | "specialist_agent" | "supervisor" | "runtime") {
  let callerAttestation = callerTokens.get(caller);
  if (callerAttestation === undefined) {
    callerAttestation = callerAttestations.issuer.issue(caller);
    callerTokens.set(caller, callerAttestation);
  }
  return {
    caller,
    callerAttestation,
    runId: "run-1",
    executionEpoch: 0
  } as const;
}

function authorize(catalog: ReturnType<typeof createCapabilityCatalog>) {
  return createPolicyEngine({
    catalog,
    approvalGate: createApprovalSystem({
      signingKey: Buffer.alloc(32, 11),
      verifyHumanPrincipal: () => ({ subject: "user-1" })
    }).gate,
    callerAttestationVerifier: callerAttestations.verifier
  });
}

describe("CapabilityCatalog", () => {
  it("validates schemas and rejects unauthorized callers before invoking handlers", async () => {
    let calls = 0;
    const catalog = createCapabilityCatalog([
      defineCapability({
        descriptor: {
          name: "profile.read",
          version: "1.0.0",
          kind: "read",
          risk: "low",
          sideEffect: "none",
          allowedCallers: ["specialist_agent"],
          requiresApproval: false,
          idempotency: "idempotent",
          timeoutMs: 5_000
        },
        inputSchema: z.object({ profileRef: z.string().min(1) }).strict(),
        outputSchema: z.object({ found: z.boolean() }).strict(),
        handler: async () => {
          calls += 1;
          return { found: true };
        }
      })
    ]);

    await expect(catalog.invoke("profile.read", { profileRef: "profile-1" }, context("specialist_agent")))
      .rejects.toThrow("capability_policy_required");
    const policy = authorize(catalog);
    const decision = await policy.authorize({
      caller: "specialist_agent",
      capability: "profile.read",
      input: { profileRef: "profile-1" },
      context: context("specialist_agent")
    });
    if (!decision.allowed) throw new Error("expected_profile_read_authorization");
    await expect(catalog.invoke("profile.read", decision.input, {
      ...context("specialist_agent"),
      permit: decision.permit
    })).resolves.toEqual({ found: true });
    await expect(catalog.invoke("profile.read", { profileRef: "profile-1" }, context("graph")))
      .rejects.toThrow("capability_caller_not_allowed");
    await expect(catalog.invoke("profile.read", { profileRef: "profile-1", extra: true }, context("specialist_agent")))
      .rejects.toThrow("capability_input_invalid");
    await expect(catalog.invoke("missing.capability", {}, context("specialist_agent")))
      .rejects.toThrow("capability_not_found");
    expect(calls).toBe(1);
  });

  it("requires keyed idempotency keys and stops a timed-out handler", async () => {
    const catalog = createCapabilityCatalog([
      defineCapability({
        descriptor: {
          name: "application.prepare",
          version: "1.0.0",
          kind: "act",
          risk: "medium",
          sideEffect: "reversible",
          allowedCallers: ["graph"],
          requiresApproval: false,
          idempotency: "keyed",
          timeoutMs: 10
        },
        inputSchema: z.object({ taskId: z.string().min(1) }).strict(),
        outputSchema: z.object({ prepared: z.boolean() }).strict(),
        handler: async (_input, invocation) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (invocation.signal.aborted) throw new Error("aborted");
          return { prepared: true };
        }
      })
    ]);

    await expect(catalog.invoke("application.prepare", { taskId: "task-1" }, context("graph")))
      .rejects.toThrow("capability_policy_required");
    const policy = authorize(catalog);
    const decision = await policy.authorize({
      caller: "graph",
      capability: "application.prepare",
      input: { taskId: "task-1" },
      context: context("graph")
    });
    expect(decision).toMatchObject({ allowed: false, reason: "capability_idempotency_key_required" });
    await expect(policy.authorize({
      caller: "graph",
      capability: "application.prepare",
      input: { taskId: "task-1" },
      context: { ...context("graph"), idempotencyKey: "" }
    })).resolves.toMatchObject({ allowed: false, reason: "capability_idempotency_key_required" });
    const authorized = await policy.authorize({
      caller: "graph",
      capability: "application.prepare",
      input: { taskId: "task-1" },
      context: { ...context("graph"), idempotencyKey: "prepare-1" }
    });
    if (!authorized.allowed) throw new Error("expected_prepare_authorization");
    await expect(catalog.invoke(
      "application.prepare",
      authorized.input,
      { ...context("graph"), idempotencyKey: "prepare-1", permit: authorized.permit }
    )).rejects.toThrow("capability_timeout");
  });

  it("rejects a keyed idempotency key when the payload changes", async () => {
    let calls = 0;
    const catalog = createCapabilityCatalog([
      defineCapability({
        descriptor: {
          name: "application.prepare",
          version: "1.0.0",
          kind: "act",
          risk: "medium",
          sideEffect: "reversible",
          allowedCallers: ["graph"],
          requiresApproval: false,
          idempotency: "keyed",
          timeoutMs: 5_000
        },
        inputSchema: z.object({ taskId: z.string().min(1) }).strict(),
        outputSchema: z.object({ prepared: z.boolean() }).strict(),
        handler: async () => {
          calls += 1;
          return { prepared: true };
        }
      })
    ]);

    const policy = authorize(catalog);
    const first = await policy.authorize({
      caller: "graph",
      capability: "application.prepare",
      input: { taskId: "task-1" },
      context: { ...context("graph"), idempotencyKey: "prepare-1" }
    });
    if (!first.allowed) throw new Error("expected_first_prepare_authorization");
    await expect(catalog.invoke(
      "application.prepare",
      first.input,
      { ...context("graph"), idempotencyKey: "prepare-1", permit: first.permit }
    )).resolves.toEqual({ prepared: true });
    const second = await policy.authorize({
      caller: "graph",
      capability: "application.prepare",
      input: { taskId: "task-2" },
      context: { ...context("graph"), idempotencyKey: "prepare-1" }
    });
    if (!second.allowed) throw new Error("expected_second_prepare_authorization");
    await expect(catalog.invoke(
      "application.prepare",
      second.input,
      { ...context("graph"), idempotencyKey: "prepare-1", permit: second.permit }
    )).rejects.toThrow("capability_idempotency_conflict");
    expect(calls).toBe(1);
  });

  it("rejects promptly when the caller aborts even if a handler ignores the signal", async () => {
    const controller = new AbortController();
    const catalog = createCapabilityCatalog([
      defineCapability({
        descriptor: {
          name: "slow.read",
          version: "1.0.0",
          kind: "read",
          risk: "low",
          sideEffect: "none",
          allowedCallers: ["graph"],
          requiresApproval: false,
          idempotency: "none",
          timeoutMs: 5_000
        },
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({ done: z.boolean() }).strict(),
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { done: true };
        }
      })
    ]);

    const policy = authorize(catalog);
    const decision = await policy.authorize({
      caller: "graph",
      capability: "slow.read",
      input: {},
      context: context("graph")
    });
    if (!decision.allowed) throw new Error("expected_slow_read_authorization");
    const startedAt = Date.now();
    const operation = catalog.invoke("slow.read", decision.input, {
      ...context("graph"),
      signal: controller.signal,
      permit: decision.permit
    });
    controller.abort("cancelled");
    await expect(operation).rejects.toThrow("capability_cancelled");
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  it("rejects a permit when authorization input or runtime context changes", async () => {
    const catalog = createCapabilityCatalog([
      defineCapability({
        descriptor: {
          name: "profile.read",
          version: "1.0.0",
          kind: "read",
          risk: "low",
          sideEffect: "none",
          allowedCallers: ["graph"],
          requiresApproval: false,
          idempotency: "none",
          timeoutMs: 5_000
        },
        inputSchema: z.object({ profileRef: z.string().min(1) }).strict(),
        outputSchema: z.object({ found: z.boolean() }).strict(),
        handler: async () => ({ found: true })
      })
    ]);
    const policy = authorize(catalog);
    const decision = await policy.authorize({
      caller: "graph",
      capability: "profile.read",
      input: { profileRef: "profile-1" },
      context: context("graph")
    });
    if (!decision.allowed) throw new Error("expected_profile_read_authorization");

    await expect(catalog.invoke("profile.read", { profileRef: "profile-2" }, {
      ...context("graph"),
      permit: decision.permit
    })).rejects.toThrow("capability_authorization_mismatch");
    await expect(catalog.invoke("profile.read", decision.input, {
      ...context("graph"),
      executionEpoch: 1,
      permit: decision.permit
    })).rejects.toThrow("capability_authorization_mismatch");
  });

  it("does not start a handler when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("cancelled-before-invoke");
    const handler = vi.fn(async () => ({ done: true }));
    const catalog = createCapabilityCatalog([
      defineCapability({
        descriptor: {
          name: "already.cancelled",
          version: "1.0.0",
          kind: "read",
          risk: "low",
          sideEffect: "none",
          allowedCallers: ["graph"],
          requiresApproval: false,
          idempotency: "none",
          timeoutMs: 5_000
        },
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({ done: z.boolean() }).strict(),
        handler
      })
    ]);
    const policy = authorize(catalog);
    const decision = await policy.authorize({
      caller: "graph",
      capability: "already.cancelled",
      input: {},
      context: context("graph")
    });
    if (!decision.allowed) throw new Error("expected_already_cancelled_authorization");

    await expect(catalog.invoke("already.cancelled", decision.input, {
      ...context("graph"),
      signal: controller.signal,
      permit: decision.permit
    })).rejects.toThrow("capability_cancelled");
    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves old keyed idempotency records instead of evicting them at capacity", async () => {
    let calls = 0;
    const catalog = createCapabilityCatalog([
      defineCapability({
        descriptor: {
          name: "bounded.keyed",
          version: "1.0.0",
          kind: "act",
          risk: "medium",
          sideEffect: "reversible",
          allowedCallers: ["graph"],
          requiresApproval: false,
          idempotency: "keyed",
          timeoutMs: 5_000
        },
        inputSchema: z.object({ value: z.number().int().nonnegative() }).strict(),
        outputSchema: z.object({ value: z.number().int().nonnegative() }).strict(),
        handler: async (input) => { calls += 1; return input; }
      })
    ]);
    const policy = authorize(catalog);
    const authorizeAndInvoke = async (value: number, idempotencyKey: string) => {
      const decision = await policy.authorize({
        caller: "graph",
        capability: "bounded.keyed",
        input: { value },
        context: { ...context("graph"), idempotencyKey }
      });
      if (!decision.allowed) throw new Error(`expected_authorization:${idempotencyKey}`);
      return catalog.invoke("bounded.keyed", decision.input, {
        ...context("graph"),
        idempotencyKey,
        permit: decision.permit
      });
    };

    await authorizeAndInvoke(0, "key-0");
    for (let index = 1; index < 1_000; index += 1) {
      await authorizeAndInvoke(index, `key-${index}`);
    }
    await expect(authorizeAndInvoke(0, "key-0")).resolves.toEqual({ value: 0 });
    await expect(authorizeAndInvoke(1_000, "key-1000")).rejects.toThrow("capability_idempotency_capacity_exceeded");
    expect(calls).toBe(1_000);
  });

  it("deeply freezes descriptor policy metadata", () => {
    const catalog = createCapabilityCatalog([
      defineCapability({
        descriptor: {
          name: "frozen.descriptor",
          version: "1.0.0",
          kind: "read",
          risk: "low",
          sideEffect: "none",
          allowedCallers: ["graph"],
          requiresApproval: false,
          idempotency: "idempotent",
          timeoutMs: 5_000,
          inputSchema: { nested: { mutable: true } }
        },
        inputSchema: z.object({}).strict(),
        outputSchema: z.object({ done: z.boolean() }).strict(),
        handler: async () => ({ done: true })
      })
    ]);
    const descriptor = catalog.describe("frozen.descriptor");
    expect(descriptor).toBeDefined();
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor!.allowedCallers)).toBe(true);
    expect(Object.isFrozen(descriptor!.inputSchema)).toBe(true);
    expect(Object.isFrozen((descriptor!.inputSchema as { nested: object }).nested)).toBe(true);
    expect(() => descriptor!.allowedCallers.push("runtime")).toThrow();
    expect(() => ((descriptor!.inputSchema as { nested: { mutable: boolean } }).nested.mutable = false)).toThrow();
  });
});
