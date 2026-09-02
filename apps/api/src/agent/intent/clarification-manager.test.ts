import { describe, expect, it } from "vitest";
import { createClarificationManager } from "./clarification-manager.js";

describe("ClarificationManager", () => {
  it("selects the highest-priority blocking question and only asks one", () => {
    const manager = createClarificationManager();
    const question = manager.selectQuestion([
      { field: "resumeRef", reason: "有两份简历", blocking: true, priority: 60 },
      { field: "targetJob", reason: "有两个候选岗位", blocking: true, priority: 90 },
      { field: "salary", reason: "可选偏好", blocking: false, priority: 10 }
    ], []);

    expect(question.relatedFields).toEqual(["targetJob"]);
    expect(question.blocking).toBe(true);
    expect(question.question).toContain("岗位");
  });

  it("turns an interrupt answer into a new intent revision", () => {
    const manager = createClarificationManager();
    const next = manager.applyAnswer({
      intentId: "intent-1",
      schemaVersion: "1.0.0",
      revision: 1,
      rawInputRef: "message-1",
      primaryGoal: "prepare_application",
      subGoals: ["identify_target_job"],
      entities: {},
      constraints: [],
      preferences: [],
      successCriteria: [],
      riskProfile: { level: "high", requiresHumanApproval: true, reasons: ["application"] },
      confidence: 0.8,
      ambiguities: [],
      missingInformation: [{ field: "targetJob", reason: "需要岗位", blocking: true, priority: 90 }],
      autonomyLevel: "execute_with_approval",
      evidenceRefs: [],
      createdAt: "2026-09-02T00:00:00.000Z"
    }, {
      interruptId: "question-1",
      action: "confirm",
      values: { targetJob: "job-1" }
    });

    expect(next.revision).toBe(2);
    expect(next.missingInformation).toEqual([]);
    expect(next.entities.targetJob?.source).toBe("user_clarified");
  });
});
