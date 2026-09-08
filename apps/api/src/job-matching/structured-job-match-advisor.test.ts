import type { StructuredGenerationInput, StructuredModelProvider } from "@resume/model-provider";
import { describe, expect, it } from "vitest";
import { createStructuredJobMatchAdvisor } from "./structured-job-match-advisor.js";

class StubStructuredProvider implements StructuredModelProvider {
  readonly inputs: Array<{ system: string; user: string; jsonExample: unknown }> = [];

  async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
    this.inputs.push({ system: input.system, user: input.user, jsonExample: input.jsonExample });
    return input.schema.parse({ outcome: "satisfied", confidence: 0.95, evidenceIds: ["evidence-1"] });
  }
}

describe("structured job-match advisor", () => {
  it("sends only the bounded requirement and supplied evidence candidates to the model", async () => {
    const provider = new StubStructuredProvider();
    const advisor = createStructuredJobMatchAdvisor(provider);

    await expect(advisor.advise({
      requirement: { id: "requirement-1", category: "skill", normalizedValue: "container orchestration", required: true },
      evidenceIds: ["evidence-1", "evidence-2"],
      evidence: [
        { evidenceId: "evidence-1", normalizedCategory: "skills[0].name", normalizedValue: "Kubernetes platform" },
        { evidenceId: "evidence-2", normalizedCategory: "projects[0].summary", normalizedValue: "Container scheduling" }
      ]
    })).resolves.toEqual({ outcome: "satisfied", confidence: 0.95, evidenceIds: ["evidence-1"] });

    expect(provider.inputs).toHaveLength(1);
    expect(JSON.parse(provider.inputs[0]!.user)).toEqual({
      requirement: { id: "requirement-1", category: "skill", normalizedValue: "container orchestration", required: true },
      evidence: [
        { evidenceId: "evidence-1", normalizedCategory: "skills[0].name", normalizedValue: "Kubernetes platform" },
        { evidenceId: "evidence-2", normalizedCategory: "projects[0].summary", normalizedValue: "Container scheduling" }
      ]
    });
  });

  it("rejects mismatched evidence identities before the model call", async () => {
    const provider = new StubStructuredProvider();
    const advisor = createStructuredJobMatchAdvisor(provider);

    await expect(advisor.advise({
      requirement: { id: "requirement-1", category: "skill", normalizedValue: "container orchestration", required: true },
      evidenceIds: ["evidence-1"],
      evidence: [{ evidenceId: "other-evidence", normalizedCategory: "skills[0].name", normalizedValue: "Kubernetes" }]
    })).rejects.toThrow();

    expect(provider.inputs).toHaveLength(0);
  });
});
