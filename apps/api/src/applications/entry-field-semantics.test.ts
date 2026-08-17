import { describe, expect, it } from "vitest";
import type { FormField } from "@resume/contracts";
import { deriveEntrySemanticHints } from "./entry-field-semantics.js";
const fixtureNodeRef = {
  documentId: "document-fixture-00000001",
  nodeId: "node-fixture-000000000001",
  observedAt: 7
};



function field(id: string, label: string): FormField {
  return { nodeRef: fixtureNodeRef, id, label, type: "text", required: false, options: [], currentValue: "" };
}

describe("deriveEntrySemanticHints", () => {
  it("does not route internship facts into an explicitly empty formal-work section", () => {
    const fields = deriveEntrySemanticHints([
      { ...field("work-company", "\u516c\u53f8\u540d\u79f0"), sectionHint: "work" },
      { ...field("work-position", "\u804c\u4f4d"), sectionHint: "work" },
      { ...field("internship-company", "\u5b9e\u4e60\u5355\u4f4d"), sectionHint: "internship" },
      { ...field("internship-position", "\u5b9e\u4e60\u5c97\u4f4d"), sectionHint: "internship" }
    ], { experienceIndexesBySection: { work: [], internship: [0] } });

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      undefined,
      undefined,
      "work[0].company",
      "work[0].position"
    ]);
  });

  it("maps separated internship entries to their compatible non-contiguous profile indexes", () => {
    const fields = deriveEntrySemanticHints([
      { ...field("company", "\u5b9e\u4e60\u5355\u4f4d"), sectionHint: "internship" },
      { ...field("position", "\u5b9e\u4e60\u5c97\u4f4d"), sectionHint: "internship" }
    ], { experienceIndexesBySection: { internship: [2] } });

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "work[2].company",
      "work[2].position"
    ]);
  });

  it("keeps combined work entries in compatible profile order", () => {
    const fields = deriveEntrySemanticHints([
      { ...field("company-1", "\u516c\u53f8\u540d\u79f0"), sectionHint: "work_combined" },
      { ...field("position-1", "\u804c\u4f4d"), sectionHint: "work_combined" },
      { ...field("company-2", "\u516c\u53f8\u540d\u79f0"), sectionHint: "work_combined" },
      { ...field("position-2", "\u804c\u4f4d"), sectionHint: "work_combined" }
    ], { experienceIndexesBySection: { work_combined: [0, 1] } });

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "work[0].company",
      "work[0].position",
      "work[1].company",
      "work[1].position"
    ]);
  });

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

  it("reindexes repeated entry starts that the DJI catalog initially maps to the first entry", () => {
    const fields = deriveEntrySemanticHints([
      {
        ...field("project-1-name", "\u9879\u76ee\u540d\u79f0"),
        semanticHint: "projects[0].name",
        semanticSource: "dji_catalog"
      },
      field("project-1-description", "\u9879\u76ee\u63cf\u8ff0"),
      {
        ...field("project-2-name", "\u9879\u76ee\u540d\u79f0"),
        semanticHint: "projects[0].name",
        semanticSource: "dji_catalog"
      },
      field("project-2-description", "\u9879\u76ee\u63cf\u8ff0")
    ]);

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "projects[0].name",
      "projects[0].description",
      "projects[1].name",
      "projects[1].description"
    ]);
  });

  it("reindexes repeated entry starts from a certified DJI hint pack", () => {
    const provenance = {
      packId: "dji-campus",
      packVersion: "1.0.0",
      confidence: 1,
      certification: "certified" as const
    };
    const fields = deriveEntrySemanticHints([
      {
        ...field("project-1-name", "项目名称"),
        semanticHint: "projects[0].name",
        semanticSource: "certified_hint",
        semanticProvenance: provenance
      },
      field("project-1-description", "项目描述"),
      {
        ...field("project-2-name", "项目名称"),
        semanticHint: "projects[0].name",
        semanticSource: "certified_hint",
        semanticProvenance: provenance
      },
      field("project-2-description", "项目描述")
    ]);

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "projects[0].name",
      "projects[0].description",
      "projects[1].name",
      "projects[1].description"
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

  it("maps repeated DJI project date pairs to start and end date components", () => {
    const fields = deriveEntrySemanticHints([
      field("project-1-name", "项目名称"),
      { ...field("project-1-start-year", "起止时间 年"), type: "select", options: [] },
      { ...field("project-1-start-month", "起止时间 月"), type: "select", options: [] },
      { ...field("project-1-end-year", "起止时间 年"), type: "select", options: [] },
      { ...field("project-1-end-month", "起止时间 月"), type: "select", options: [] },
      field("project-2-name", "项目名称"),
      { ...field("project-2-start-year", "起止时间 年"), type: "select", options: [] },
      { ...field("project-2-start-month", "起止时间 月"), type: "select", options: [] },
      { ...field("project-2-end-year", "起止时间 年"), type: "select", options: [] },
      { ...field("project-2-end-month", "起止时间 月"), type: "select", options: [] }
    ]);

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "projects[0].name",
      "projects[0].startDate.year",
      "projects[0].startDate.month",
      "projects[0].endDate.year",
      "projects[0].endDate.month",
      "projects[1].name",
      "projects[1].startDate.year",
      "projects[1].startDate.month",
      "projects[1].endDate.year",
      "projects[1].endDate.month"
    ]);
  });

  it("refines a block-level award hint into the concrete field path", () => {
    const fields = deriveEntrySemanticHints([
      { ...field("award-name", "\u8d5b\u4e8b\u540d\u79f0"), semanticHint: "awards[0]" },
      { ...field("award-year", "\u8d5b\u4e8b\u65f6\u95f4 \u5e74"), type: "select", options: [], semanticHint: "awards[0]" },
      { ...field("award-month", "\u8d5b\u4e8b\u65f6\u95f4 \u6708"), type: "select", options: [], semanticHint: "awards[0]" },
      { ...field("award-description", "\u8d5b\u4e8b\u63cf\u8ff0"), semanticHint: "awards[0]" }
    ]);

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "awards[0].name",
      "awards[0].date.year",
      "awards[0].date.month",
      "awards[0].description"
    ]);
  });

  it("preserves a more specific existing semantic hint", () => {
    const fields = deriveEntrySemanticHints([
      { ...field("award-name", "\u8d5b\u4e8b\u540d\u79f0"), semanticHint: "awards[0].customName" },
      field("award-description", "\u8d5b\u4e8b\u63cf\u8ff0")
    ]);

    expect(fields[0]?.semanticHint).toBe("awards[0].customName");
    expect(fields[1]?.semanticHint).toBe("awards[0].description");
  });

  it("maps an education laboratory question to a derived boolean semantic", () => {
    const fields = deriveEntrySemanticHints([
      field("school", "\u5b66\u6821"),
      field("laboratory", "\u662f\u5426\u6709\u5b9e\u9a8c\u5ba4\u7ecf\u5386"),
      field("major", "\u4e13\u4e1a")
    ]);

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "education[0].institution",
      "education[0].hasLaboratory",
      "education[0].major"
    ]);
  });

  it("maps real DJI generic date labels after catalogued repeated entry starts", () => {
    const fields = deriveEntrySemanticHints([
      {
        ...field("project-1-name", "\u9879\u76ee\u540d\u79f0"),
        semanticHint: "projects[0].name",
        semanticSource: "dji_catalog"
      },
      { ...field("project-1-start-year", "\u8d77\u6b62\u65f6\u95f4 \u5e74"), type: "select", options: [] },
      { ...field("project-1-start-month", "\u8d77\u6b62\u65f6\u95f4 \u6708"), type: "select", options: [] },
      { ...field("project-1-end-year", "\u8d77\u6b62\u65f6\u95f4 \u5e74"), type: "select", options: [] },
      { ...field("project-1-end-month", "\u8d77\u6b62\u65f6\u95f4 \u6708"), type: "select", options: [] },
      {
        ...field("project-2-name", "\u9879\u76ee\u540d\u79f0"),
        semanticHint: "projects[0].name",
        semanticSource: "dji_catalog"
      },
      { ...field("project-2-start-year", "\u8d77\u6b62\u65f6\u95f4 \u5e74"), type: "select", options: [] },
      { ...field("project-2-start-month", "\u8d77\u6b62\u65f6\u95f4 \u6708"), type: "select", options: [] },
      { ...field("project-2-end-year", "\u8d77\u6b62\u65f6\u95f4 \u5e74"), type: "select", options: [] },
      { ...field("project-2-end-month", "\u8d77\u6b62\u65f6\u95f4 \u6708"), type: "select", options: [] },
      {
        ...field("award-name", "\u8d5b\u4e8b\u540d\u79f0"),
        semanticHint: "awards[0].name",
        semanticSource: "dji_catalog"
      },
      { ...field("award-year", "\u8d77\u6b62\u65f6\u95f4 \u5e74"), type: "select", options: [] },
      { ...field("award-month", "\u8d77\u6b62\u65f6\u95f4 \u6708"), type: "select", options: [] }
    ]);

    expect(fields.map((candidate) => candidate.semanticHint)).toEqual([
      "projects[0].name",
      "projects[0].startDate.year",
      "projects[0].startDate.month",
      "projects[0].endDate.year",
      "projects[0].endDate.month",
      "projects[1].name",
      "projects[1].startDate.year",
      "projects[1].startDate.month",
      "projects[1].endDate.year",
      "projects[1].endDate.month",
      "awards[0].name",
      "awards[0].date.year",
      "awards[0].date.month"
    ]);
  });
});
