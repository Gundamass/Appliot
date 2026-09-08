import { describe, expect, it } from "vitest";
import { createIntentResolver } from "./intent-resolver.js";

describe("IntentResolver", () => {
  it("resolves explicit and implicit application goals without inferring approval credentials", async () => {
    const resolver = createIntentResolver();
    const result = await resolver.resolve(
      { text: "帮我投这个岗位，先填表，提交前让我确认" },
      { availableJobs: [{ id: "job-1", label: "目标岗位" }], availableResumes: [{ id: "resume-1", label: "最新简历" }] }
    );

    expect(result.type).toBe("resolved");
    if (result.type === "resolved") {
      expect(result.intent.subGoals).toEqual(expect.arrayContaining(["fill_application", "request_human_approval"]));
      expect(result.intent.riskProfile.requiresHumanApproval).toBe(true);
      expect(result.intent.autonomyLevel).toBe("execute_with_approval");
    }
  });

  it("asks for the highest-impact missing target job", async () => {
    const resolver = createIntentResolver();
    const result = await resolver.resolve(
      { text: "帮我申请后端岗位" },
      {
        availableJobs: [{ id: "job-1", label: "后端工程师" }, { id: "job-2", label: "高级后端工程师" }],
        availableResumes: [{ id: "resume-1", label: "2026 简历" }, { id: "resume-2", label: "后端简历" }]
      }
    );

    expect(result.type).toBe("needs_clarification");
    if (result.type === "needs_clarification") {
      expect(result.question.relatedFields).toEqual(["targetJob"]);
    }
  });
});
