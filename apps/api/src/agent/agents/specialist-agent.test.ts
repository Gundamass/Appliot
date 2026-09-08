import { describe, expect, it } from "vitest";
import { SpecialistAgentResultSchema } from "./specialist-agent.js";

describe("SpecialistAgent contract", () => {
  it("requires references for a completed specialist result", () => {
    expect(() => SpecialistAgentResultSchema.parse({ status: "completed" })).toThrow();
  });

  it("does not allow a specialist result to carry browser handles or raw content", () => {
    expect(() => SpecialistAgentResultSchema.parse({
      status: "completed",
      outputRef: "output:1",
      evidenceRefs: [],
      browserHandle: "page"
    })).toThrow();
  });
});
