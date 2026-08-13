import { describe, expect, it } from "vitest";
import type { FormField } from "@resume/contracts";
import { deriveEntrySemanticHints } from "./entry-field-semantics.js";

function field(id: string, label: string): FormField {
  return { id, label, type: "text", required: false, options: [], currentValue: "" };
}

describe("deriveEntrySemanticHints", () => {
  it("maps repeated Mokahr project entries to their matching knowledge-base paths", () => {
    const fields = deriveEntrySemanticHints([
      field("project-1-name", "项目名称"),
      field("project-1-description", "项目描述"),
      field("project-1-stack", "技术栈"),
      field("project-2-name", "项目名称"),
      field("project-2-description", "项目描述"),
      field("project-2-highlights", "项目要点")
    ]);

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "projects[0].name",
      "projects[0].description",
      "projects[0].technologies",
      "projects[1].name",
      "projects[1].description",
      "projects[1].highlights[0]"
    ]);
  });

  it("uses canonical profile paths for education and internship entries", () => {
    const fields = deriveEntrySemanticHints([
      field("school", "学校"),
      field("degree", "学历"),
      field("major", "专业"),
      field("education-description", "教育描述"),
      field("company", "公司"),
      field("position", "职位"),
      field("employment-type", "用工类型"),
      field("work-description", "职责和成果")
    ]);

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "education[0].institution",
      "education[0].degree",
      "education[0].major",
      "education[0].description",
      "work[0].company",
      "work[0].position",
      "work[0].employmentType",
      "work[0].description"
    ]);
  });

  it("does not assign an unrelated generic description to the preceding project", () => {
    const fields = deriveEntrySemanticHints([
      field("project-name", "项目名称"),
      field("project-description", "项目描述"),
      field("award-description", "描述"),
      field("language-description", "语言证书及成绩")
    ]);

    expect(fields.find((candidate) => candidate.id === "project-description")?.semanticHint).toBe("projects[0].description");
    expect(fields.find((candidate) => candidate.id === "award-description")?.semanticHint).toBeUndefined();
    expect(fields.find((candidate) => candidate.id === "language-description")?.semanticHint).toBeUndefined();
  });

  it("preserves repeated-entry context for a field that requires semantic mapping", () => {
    const fields = deriveEntrySemanticHints([
      field("school", "学校名称"),
      { ...field("training-mode", "培养方式"), type: "select", options: ["统招", "定向"] },
      field("major", "专业名称")
    ]);

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "education[0].institution",
      "education[0]",
      "education[0].major"
    ]);
  });

  it("maps repeated competition fields to separate award entries", () => {
    const fields = deriveEntrySemanticHints([
      field("award-1-name", "赛事名称"),
      field("award-1-date", "赛事时间"),
      { ...field("award-1-level", "奖项级别"), type: "select", options: ["国家级", "校级"] },
      field("award-1-description", "赛事描述"),
      field("award-2-name", "获奖名称"),
      field("award-2-date", "获奖时间"),
      field("award-2-description", "奖项描述")
    ]);

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "awards[0].name",
      "awards[0].date",
      "awards[0].level",
      "awards[0].description",
      "awards[1].name",
      "awards[1].date",
      "awards[1].description"
    ]);
  });

  it("maps DJI award fields to exact fact paths and date components", () => {
    const fields = deriveEntrySemanticHints([
      field("award-name", "\u8d5b\u4e8b\u540d\u79f0"),
      { ...field("award-year", "\u8d5b\u4e8b\u65f6\u95f4 \u5e74"), type: "select", options: ["2024", "2025"] },
      { ...field("award-month", "\u8d5b\u4e8b\u65f6\u95f4 \u6708"), type: "select", options: ["1", "2"] },
      field("award-description", "\u8d5b\u4e8b\u63cf\u8ff0")
    ]);

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "awards[0].name",
      "awards[0].date.year",
      "awards[0].date.month",
      "awards[0].description"
    ]);
  });

  it("keeps split year and month controls inside the current award entry", () => {
    const fields = deriveEntrySemanticHints([
      field("award-1-name", "赛事名称"),
      { ...field("award-1-year", "起止时间 年"), type: "select", options: ["2025", "2026"] },
      { ...field("award-1-month", "起止时间 月"), type: "select", options: ["3", "4"] },
      field("award-2-name", "获奖名称"),
      { ...field("award-2-year", "起止时间 年"), type: "select", options: ["2024", "2025"] },
      { ...field("award-2-month", "起止时间 月"), type: "select", options: ["8", "9"] }
    ]);

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "awards[0].name",
      "awards[0].date.year",
      "awards[0].date.month",
      "awards[1].name",
      "awards[1].date.year",
      "awards[1].date.month"
    ]);
  });
});
