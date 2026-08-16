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

  it("不把选填项目链接计入缺失字段", () => {
    const result = calculateProfileCompleteness([
      fact("projects[0].name", "简历投递助手", "user_corrected")
    ]);

    expect(result.sections.find((section) => section.id === "projects")?.missing)
      .not.toContain("projects[0].url");
  });

  it("在校实践只把独立时间计入建议补全，实践成果保持选填", () => {
    const result = calculateProfileCompleteness([
      fact("campus[0].name", "创E社团招新", "user_corrected"),
      fact("campus[0].role", "组织者", "user_corrected"),
      fact("campus[0].description", "手写描述", "user_corrected"),
      fact("campus[1].name", "新枫读书节", "user_corrected"),
      fact("campus[1].role", "策划和组织", "user_corrected"),
      fact("campus[1].description", "手写描述", "user_corrected")
    ]);

    expect(result.sections.find((section) => section.id === "campus")).toMatchObject({
      completed: 6,
      total: 10,
      missing: [
        "campus[0].startDate",
        "campus[0].endDate",
        "campus[1].startDate",
        "campus[1].endDate"
      ]
    });
  });

  it("独立统计语言能力字段且不把语言证书当作语言能力", () => {
    const complete = calculateProfileCompleteness([
      fact("languages[0].name", "英语", "user_confirmed"),
      fact("languages[0].proficiency", "熟练", "user_confirmed"),
      fact("languages[0].speakingListening", "熟练", "user_confirmed"),
      fact("languages[0].readingWriting", "熟练", "user_confirmed"),
      fact("certificates[0].name", "大学英语六级", "user_confirmed")
    ]);

    expect(complete.sections.find((section) => section.id === "languages")).toMatchObject({
      label: "语言能力",
      completed: 4,
      total: 4,
      missing: []
    });

    const certificateOnly = calculateProfileCompleteness([
      fact("certificates[0].name", "大学英语六级", "user_confirmed")
    ]);
    expect(certificateOnly.sections.find((section) => section.id === "languages")).toEqual({
      id: "languages",
      label: "语言能力",
      completed: 1,
      total: 1,
      missing: []
    });
  });
});
