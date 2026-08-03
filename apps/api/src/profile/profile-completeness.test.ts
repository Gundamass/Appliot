import { describe, expect, it } from "vitest";
import type { ProfileFact } from "@resume/contracts";
import { calculateProfileCompleteness } from "./profile-completeness.js";

function fact(
  fieldPath: string,
  value: string,
  status: ProfileFact["status"],
  scope: ProfileFact["scope"] = "profile"
): ProfileFact {
  return {
    id: `${scope}-${status}-${fieldPath}`,
    fieldPath,
    value,
    status,
    confidence: status === "extracted" ? 0.8 : 1,
    scope,
    ...(scope === "application" ? { taskId: "task-1" } : {}),
    evidence: [{ documentId: "test", page: 1, text: value, extraction: "user" }],
    revision: 1
  };
}

describe("calculateProfileCompleteness", () => {
  it("counts only confirmed or corrected profile facts as complete", () => {
    const result = calculateProfileCompleteness([
      fact("basics.name", "陈同学", "extracted"),
      fact("preferences.targetRole", "Java 后端开发实习", "user_confirmed"),
      fact("preferences.targetCity", "杭州", "user_confirmed", "application")
    ]);

    expect(result.sections.find((section) => section.id === "basics")).toMatchObject({
      completed: 0,
      missing: expect.arrayContaining(["basics.name"])
    });
    expect(result.sections.find((section) => section.id === "preferences")).toMatchObject({
      completed: 1,
      missing: expect.arrayContaining(["preferences.targetCity"])
    });
  });

  it("checks repeated sections only for entries already present in the profile", () => {
    const empty = calculateProfileCompleteness([]);
    expect(empty.sections.find((section) => section.id === "awards")).toEqual({
      id: "awards",
      label: "获奖经历",
      completed: 1,
      total: 1,
      missing: []
    });

    const withAward = calculateProfileCompleteness([
      fact("awards[2].name", "全国大学生软件创新大赛一等奖", "user_corrected")
    ]);
    expect(withAward.sections.find((section) => section.id === "awards")).toMatchObject({
      completed: 1,
      total: 4,
      missing: ["awards[2].date", "awards[2].level", "awards[2].description"]
    });
  });
});
