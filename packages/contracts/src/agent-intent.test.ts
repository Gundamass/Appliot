import { describe, expect, it } from "vitest";
import {
  CanonicalIntentSchema,
  ClarificationRequestSchema,
  IntentResolutionSchema
} from "./agent-intent.js";

const evidence = {
  id: "evidence-1",
  kind: "document",
  sourceRef: "resume-1",
  contentHash: "a".repeat(64)
} as const;

describe("agent intent contracts", () => {
  it("accepts a resolved application intent with explicit approval", () => {
    const intent = CanonicalIntentSchema.parse({
      intentId: "intent-1",
      schemaVersion: "1.0.0",
      revision: 1,
      rawInputRef: "message-1",
      primaryGoal: "prepare_application",
      subGoals: ["analyze_job", "match_resume_to_job", "fill_application", "request_human_approval"],
      entities: {
        company: { value: "字节跳动", source: "user_explicit", confidence: 1, evidenceRefs: [], requiresConfirmation: false }
      },
      constraints: [{
        type: "submit_requires_approval",
        value: true,
        source: "user_explicit",
        confidence: 1,
        evidenceRefs: []
      }],
      preferences: [],
      successCriteria: [{ id: "form-ready", description: "表单填写完成但不提交", required: true }],
      riskProfile: {
        level: "irreversible",
        requiresHumanApproval: true,
        reasons: ["final submission is external"]
      },
      confidence: 0.98,
      ambiguities: [],
      missingInformation: [],
      autonomyLevel: "execute_with_approval",
      evidenceRefs: [evidence],
      createdAt: "2026-09-02T00:00:00.000Z"
    });

    expect(intent.primaryGoal).toBe("prepare_application");
    expect(intent.riskProfile.requiresHumanApproval).toBe(true);
  });

  it("requires confirmation when a critical field comes only from model inference", () => {
    const result = CanonicalIntentSchema.safeParse({
      intentId: "intent-2",
      schemaVersion: "1.0.0",
      revision: 1,
      rawInputRef: "message-2",
      primaryGoal: "submit_application",
      subGoals: ["request_human_approval"],
      entities: {
        targetJob: { value: "后端岗位", source: "model_inference", confidence: 0.7, evidenceRefs: [], requiresConfirmation: false }
      },
      constraints: [],
      preferences: [],
      successCriteria: [],
      riskProfile: { level: "irreversible", requiresHumanApproval: true, reasons: ["external submission"] },
      confidence: 0.7,
      ambiguities: [],
      missingInformation: [],
      autonomyLevel: "execute_with_approval",
      evidenceRefs: [],
      createdAt: "2026-09-02T00:00:00.000Z"
    });

    expect(result.success).toBe(false);
  });

  it("accepts a clarification request and a partial resolution", () => {
    const question = ClarificationRequestSchema.parse({
      questionId: "question-1",
      question: "请选择要使用的简历",
      options: [{ id: "resume-a", label: "2026 春招简历" }],
      blocking: true,
      relatedFields: ["resumeRef"]
    });
    const resolution = IntentResolutionSchema.parse({
      type: "needs_clarification",
      intent: { intentId: "intent-3", schemaVersion: "1.0.0", revision: 1, rawInputRef: "message-3" },
      question
    });

    expect(resolution.type).toBe("needs_clarification");
  });
});
