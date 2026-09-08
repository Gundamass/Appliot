import { describe, expect, it } from "vitest";
import { FakeStructuredModelProvider } from "@resume/model-provider";
import { createIntentUnderstanding } from "./intent-understanding.js";

describe("structured intent understanding", () => {
  it("uses structured understanding for nuanced intent and keeps evidence references scoped", async () => {
    const provider = new FakeStructuredModelProvider({
      primaryGoal: "fill_application",
      subGoals: ["prepare_application", "fill_application", "verify_application"],
      entities: {
        company: {
          value: "目标公司",
          source: "model_inference",
          confidence: 0.86,
          evidenceRefs: ["evidence-allowed", "evidence-hallucinated"]
        }
      },
      constraints: [],
      preferences: [],
      successCriteria: [{ id: "filled", description: "填写并核验表单", required: true }],
      confidence: 0.86,
      autonomyLevel: "execute_with_approval",
      evidenceRefs: ["evidence-allowed", "evidence-hallucinated"]
    });
    const understanding = createIntentUnderstanding({ structuredProvider: provider });

    const draft = await understanding.extract(
      { text: "只填写目标公司的申请表，完成后让我复核" },
      {
        availableJobs: [{ id: "job-1", label: "目标岗位" }],
        availableResumes: [{ id: "resume-1", label: "最新简历" }],
        evidenceRefs: [{
          id: "evidence-allowed",
          kind: "document",
          sourceRef: "document-1",
          contentHash: "a".repeat(64)
        }]
      }
    );

    expect(draft.primaryGoal).toBe("fill_application");
    expect(draft.entities.company?.requiresConfirmation).toBe(true);
    expect(draft.entities.company?.evidenceRefs).toEqual(["evidence-allowed"]);
    expect(draft.evidenceRefs?.map((ref) => ref.id)).toEqual(["evidence-allowed"]);
  });

  it("falls back to deterministic extraction when the structured provider is unavailable", async () => {
    const understanding = createIntentUnderstanding({
      structuredProvider: { generateStructured: async () => { throw new Error("provider_timeout"); } }
    });

    const draft = await understanding.extract({ text: "\u5e2e\u6211\u7528\u6700\u65b0\u7b80\u5386\u7533\u8bf7\u5b57\u8282\u7684\u540e\u7aef\u5c97\u4f4d\uff0c\u5148\u586b\u8868\uff0c\u63d0\u4ea4\u524d\u8ba9\u6211\u786e\u8ba4" });

    expect(draft.primaryGoal).toBe("prepare_application");
    expect(draft.subGoals).toEqual(expect.arrayContaining(["fill_application", "request_human_approval"]));
  });

  it("recognizes explicit filling language with an application URL", async () => {
    const understanding = createIntentUnderstanding();

    const draft = await understanding.extract({
      text: "填写 https://jobs.example.com/apply/123"
    });

    expect(draft.primaryGoal).toBe("fill_application");
    expect(draft.entities.applicationUrl?.value).toBe("https://jobs.example.com/apply/123");
  });
});

describe("IntentUnderstanding", () => {
  it("normalizes an application request into a structured draft", async () => {
    const understanding = createIntentUnderstanding();
    const draft = await understanding.extract({ text: "帮我用最新简历申请字节的后端岗位，先填表，提交前让我确认" });

    expect(draft.primaryGoal).toBe("prepare_application");
    expect(draft.subGoals).toEqual(expect.arrayContaining(["fill_application", "request_human_approval"]));
    expect(draft.entities.company?.value).toBe("字节");
    expect(draft.entities.role?.value).toBe("后端");
  });

  it("rejects extractor output that tries to smuggle runtime credentials", async () => {
    const understanding = createIntentUnderstanding({
      extractor: async () => ({
        primaryGoal: "submit_application",
        entities: {},
        constraints: [],
        preferences: [],
        successCriteria: [],
        approvalId: "forged-approval"
      })
    });

    await expect(understanding.extract({ text: "直接投递" })).rejects.toThrow("intent_extraction_invalid");
  });
});
