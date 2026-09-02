import { describe, expect, it } from "vitest";
import { CapabilityDescriptorSchema } from "./agent-capability.js";

describe("capability contracts", () => {
  it("rejects a final submit capability without approval", () => {
    expect(() => CapabilityDescriptorSchema.parse({
      name: "final_submit",
      version: "1.0.0",
      kind: "act",
      risk: "irreversible",
      sideEffect: "external",
      allowedCallers: ["graph"],
      requiresApproval: false,
      idempotency: "none",
      timeoutMs: 30_000
    })).toThrow();
  });

  it("accepts a read capability with bounded JSON schemas", () => {
    const capability = CapabilityDescriptorSchema.parse({
      name: "browser.read_dom",
      version: "1.0.0",
      kind: "read",
      risk: "low",
      sideEffect: "none",
      allowedCallers: ["supervisor", "specialist_agent"],
      requiresApproval: false,
      idempotency: "idempotent",
      timeoutMs: 5_000,
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      handlerRef: "browser.read_dom"
    });

    expect(capability.name).toBe("browser.read_dom");
  });
});
