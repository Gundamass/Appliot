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
});
