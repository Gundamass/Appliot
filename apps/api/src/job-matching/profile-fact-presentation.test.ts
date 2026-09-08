import type { JobRequirement, ProfileFact } from "@resume/contracts";
import { describe, expect, it } from "vitest";
import { presentMatchEvidence, presentProfileFact } from "./profile-fact-presentation.js";

function fact(fieldPath: string, value: ProfileFact["value"]): ProfileFact {
  return {
    id: `fact-${fieldPath}`,
    fieldPath,
    value,
    status: "user_confirmed",
    confidence: 1,
    scope: "profile",
    evidence: [{
      documentId: "resume-1",
      page: 1,
      text: "已确认的简历资料",
      extraction: "pdf_text"
    }],
    revision: 1
  };
}

function requirement(category: JobRequirement["category"]): JobRequirement {
  return {
    id: `requirement-${category}`,
    category,
    normalizedValue: "软件工程",
    required: true,
    sourceEvidence: "软件工程相关专业"
  };
}

describe("profile fact presentation", () => {
  it.each([
    ["education[0].degree", "学历"],
    ["education[0].major", "专业"],
    ["skills[0]", "技能"],
    ["skills[0].name", "技能"],
    ["work[0].description", "工作经历"],
    ["internship[1].description", "工作经历"]
  ])("presents %s with a human-readable label", (fieldPath, label) => {
    expect(presentProfileFact(fact(fieldPath, "软件工程"))).toEqual({
      label,
      value: "软件工程"
    });
  });

  it("uses a safe generic label for an unknown path", () => {
    const presented = presentProfileFact(fact("private.path", "secret"));

    expect(presented).toEqual({ label: "已确认资料", value: "secret" });
    expect(JSON.stringify(presented)).not.toMatch(/private\.path|Profile fact/u);
  });

  it("bounds long values to 120 visible characters", () => {
    const presented = presentProfileFact(fact("skills[0].name", "技".repeat(150)));

    expect(presented.value).toBe(`${"技".repeat(119)}…`);
    expect(presented.value).toHaveLength(120);
  });

  it("describes matching evidence in Chinese without exposing the raw field path", () => {
    const summary = presentMatchEvidence(
      requirement("major"),
      fact("education[0].major", "软件工程")
    );

    expect(summary).toBe("你的专业“软件工程”符合岗位专业要求。");
    expect(summary).not.toMatch(/education\[0\]\.major|Profile fact/u);
  });

  it("keeps unknown paths out of matching evidence", () => {
    const summary = presentMatchEvidence(
      requirement("skill"),
      fact("private.path", "secret")
    );

    expect(summary).toBe("你的已确认资料“secret”符合岗位技能要求。");
    expect(summary).not.toMatch(/private\.path|Profile fact/u);
  });
});
