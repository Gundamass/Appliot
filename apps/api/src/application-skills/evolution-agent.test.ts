import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { StructuredGenerationInput, StructuredModelProvider } from "@resume/model-provider";
import {
  SkillEvolutionPatchSchema,
  type ApplicationSkillContent,
  type ApplicationSkillVersion,
  type SkillEvolutionPatch
} from "@resume/contracts";
import { canonicalSkillContentHash } from "./skill-registry.js";
import { createSkillEvolutionAgent } from "./evolution-agent.js";

describe("SkillEvolutionAgent", () => {
  it("calls the structured provider once with the exact patch schema and returns a validated candidate", async () => {
    const provider = providerReturning({
      parentContentHash: parentFixture().contentHash,
      operations: [{ op: "replace", path: "/recovery", value: { maxRetries: 1, actions: ["reobserve"] } }]
    });
    const agent = createSkillEvolutionAgent(provider, { timeoutMs: 100 });

    const result = await agent.generate(inputFixture());

    expect(provider.generateStructured).toHaveBeenCalledTimes(1);
    const request = provider.generateStructured.mock.calls[0]![0];
    expect(request.schema).toBe(SkillEvolutionPatchSchema);
    expect(request.system).toContain("add, replace, and remove");
    expect(request.system).not.toMatch(/weight|traffic|submit authority/iu);
    expect(result).toEqual({
      kind: "candidate",
      content: {
        ...parentFixture().content,
        recovery: { maxRetries: 1, actions: ["reobserve"] }
      },
      contentHash: canonicalSkillContentHash({
        ...parentFixture().content,
        recovery: { maxRetries: 1, actions: ["reobserve"] }
      })
    });
  });

  it("whitelists prompt evidence so holdout, profile values, secrets, weights, and traffic policy cannot leak", async () => {
    const provider = providerReturning({
      parentContentHash: parentFixture().contentHash,
      operations: [{ op: "replace", path: "/recovery", value: { maxRetries: 1, actions: ["reobserve"] } }]
    });
    const tainted = inputFixture() as ReturnType<typeof inputFixture> & Record<string, unknown>;
    tainted.holdoutSamples = [{ sampleId: "holdout-secret-id" }];
    tainted.evaluatorWeights = { safety: 999 };
    tainted.trafficThreshold = 10;
    (tainted.trainingExamples[0] as unknown as Record<string, unknown>).rawValue = "candidate@example.com";
    (tainted.opportunity as unknown as Record<string, unknown>).approvalToken = "approval-secret";

    await createSkillEvolutionAgent(provider, { timeoutMs: 100 }).generate(tainted);

    const request = provider.generateStructured.mock.calls[0]![0];
    const serialized = `${request.system}\n${request.user}\n${JSON.stringify(request.jsonExample)}`;
    expect(request.user).toContain("trainingExamples");
    for (const forbidden of [
      "holdout-secret-id",
      "candidate@example.com",
      "approval-secret",
      "evaluatorWeights",
      "trafficThreshold",
      "final_submit"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.each([
    ["malformed output", {}, "schema"],
    ["wrong parent", { parentContentHash: "f".repeat(64), operations: [{ op: "replace", path: "/recovery", value: { maxRetries: 1, actions: ["reobserve"] } }] }, "parent"],
    ["forbidden parent capability expansion", {
      parentContentHash: parentFixture().contentHash,
      operations: [{
        op: "replace",
        path: "/capabilities",
        value: ["observe", "fill_empty_fields", "select_option", "readback", "full_page_audit"]
      }]
    }, "validation"],
    ["unchanged content", {
      parentContentHash: parentFixture().contentHash,
      operations: [{ op: "replace", path: "/recovery", value: parentFixture().content.recovery }]
    }, "unchanged"],
    ["out-of-range removal", {
      parentContentHash: parentFixture().contentHash,
      operations: [{ op: "remove", path: "/fields/99" }]
    }, "schema"]
  ] as const)("rejects %s without retrying", async (_label, response, reason) => {
    const provider = providerReturning(response);

    await expect(createSkillEvolutionAgent(provider, { timeoutMs: 100 }).generate(inputFixture()))
      .resolves.toEqual({ kind: "rejected", reason });
    expect(provider.generateStructured).toHaveBeenCalledTimes(1);
  });

  it("maps provider errors and timeouts to one stable non-candidate result without retrying", async () => {
    const failing = providerThrowing(new Error("provider unavailable"));
    const pending = providerPending();

    await expect(createSkillEvolutionAgent(failing, { timeoutMs: 100 }).generate(inputFixture()))
      .resolves.toEqual({ kind: "rejected", reason: "provider" });
    await expect(createSkillEvolutionAgent(pending, { timeoutMs: 5 }).generate(inputFixture()))
      .resolves.toEqual({ kind: "rejected", reason: "provider" });
    expect(failing.generateStructured).toHaveBeenCalledTimes(1);
    expect(pending.generateStructured).toHaveBeenCalledTimes(1);
  });

  it("rejects a parent whose declared content hash is not exact before calling the provider", async () => {
    const provider = providerReturning({});
    const input = inputFixture();

    await expect(createSkillEvolutionAgent(provider).generate({
      ...input,
      parent: { ...input.parent, contentHash: "f".repeat(64) }
    })).resolves.toEqual({ kind: "rejected", reason: "parent" });
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });

  it("rejects profile data disguised as structural metadata before calling the provider", async () => {
    const provider = providerReturning({});
    const input = inputFixture();
    const trainingExamples = structuredClone(input.trainingExamples);
    trainingExamples[0]!.controls[0]!.role = "candidate@example.com";

    await expect(createSkillEvolutionAgent(provider).generate({ ...input, trainingExamples }))
      .resolves.toEqual({ kind: "rejected", reason: "schema" });
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });

  it("rejects a stale candidate version before calling the provider", async () => {
    const provider = providerReturning({});
    const input = inputFixture();

    await expect(createSkillEvolutionAgent(provider).generate({ ...input, candidateVersion: "0.9.0" }))
      .resolves.toEqual({ kind: "rejected", reason: "parent" });
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });
});

function inputFixture() {
  return {
    evolutionRunId: "evolution-run-1",
    candidateVersion: "1.1.0",
    createdAt: "2026-09-07T10:00:00.000Z",
    parent: parentFixture(),
    trainingExamples: [{
      sampleId: "training-sample-1",
      capturedAt: "2026-09-07T08:00:00.000Z",
      partition: "training" as const,
      site: "baidu" as const,
      pageFingerprintHash: "a".repeat(64),
      scenarioClass: "renamed-label",
      controls: [{
        role: "textbox",
        tag: "input",
        type: "text",
        labelHash: "b".repeat(64),
        optionHashes: [],
        relativeStructure: { parentRole: "form", depth: 1, siblingIndex: 0 },
        hidden: false
      }],
      expectedSemantics: ["basics.name"],
      observedOutcome: {
        fieldOutcomes: [{ semantic: "basics.name", outcome: "failed" as const, errorClass: "field_missing" as const }],
        counts: { observed: 1, planned: 1, verified: 0, auditMismatches: 0, userCorrections: 0 },
        auditMismatchClasses: [],
        firstError: { stage: "resolve" as const, errorClass: "field_missing" as const, semantic: "basics.name" as const },
        retries: 1,
        recoveries: 1,
        durationMs: 500,
        terminalResult: "failed" as const
      }
    }],
    opportunity: {
      opportunityId: "evolution-opportunity-1",
      theme: { pageVariantId: "application-form", semantic: "basics.name", errorClass: "field_missing" },
      triggers: ["repeated_actionable_failure"],
      executionChain: [{
        recordId: "skill-record-1",
        completedAt: "2026-09-07T08:00:00.000Z",
        terminalResult: "failed",
        fieldOutcomes: [{ semantic: "basics.name", outcome: "failed", errorClass: "field_missing" }]
      }]
    }
  };
}

function parentFixture(): ApplicationSkillVersion {
  const content: ApplicationSkillContent = {
    capabilities: ["observe", "fill_empty_fields", "readback", "full_page_audit"],
    pageVariants: [{
      id: "application-form",
      match: {
        routePatterns: ["/jobs/detail/GRADUATE/**/apply"],
        requiredTexts: ["申请职位"],
        requiredFields: ["basics.name"]
      },
      workflowEntry: "fill-form"
    }],
    fields: [{
      semantic: "basics.name",
      controlTypes: ["text"],
      locatorHints: [{ key: "candidate-name", by: "label", text: "姓名" }]
    }],
    workflow: [{
      id: "fill-form",
      actions: [
        { capability: "observe" },
        { capability: "fill_empty_fields", semantics: ["basics.name"] },
        { capability: "readback", semantics: ["basics.name"] },
        { capability: "full_page_audit" }
      ],
      success: ["page_observed", "writes_read_back", "audit_clean"],
      next: "continue_or_wait"
    }],
    recovery: { maxRetries: 2, actions: ["reobserve", "refresh-node-ref"] }
  };
  return {
    skillId: "baidu-application",
    version: "1.0.0",
    schemaVersion: 1,
    contentHash: canonicalSkillContentHash(content),
    site: "baidu",
    allowedDomains: ["talent.baidu.com"],
    pageFingerprintRule: {
      ruleId: "baidu-application-form",
      ruleHash: createHash("sha256").update("baidu-application-form", "utf8").digest("hex")
    },
    status: "champion",
    content,
    createdBy: { kind: "manual_seed", actorId: "skill-author" },
    createdAt: "2026-09-06T00:00:00.000Z"
  };
}

type RecordedProvider = StructuredModelProvider & {
  generateStructured: StructuredModelProvider["generateStructured"] & ReturnType<typeof vi.fn>;
};

function providerReturning(response: unknown): RecordedProvider {
  const generateStructured = vi.fn(async <T>(_input: StructuredGenerationInput<T>) => response as T);
  return { generateStructured: generateStructured as RecordedProvider["generateStructured"] };
}

function providerThrowing(error: Error): RecordedProvider {
  const generateStructured = vi.fn(async () => { throw error; });
  return { generateStructured: generateStructured as RecordedProvider["generateStructured"] };
}

function providerPending(): RecordedProvider {
  const generateStructured = vi.fn(async () => await new Promise<SkillEvolutionPatch>(() => undefined));
  return { generateStructured: generateStructured as RecordedProvider["generateStructured"] };
}
