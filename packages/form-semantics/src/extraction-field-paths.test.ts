import { describe, expect, it } from "vitest";
import { isAllowedExtractedFieldPath, listExtractableFieldPathTemplates } from "./field-registry.js";

describe("简历抽取字段路径契约", () => {
  it("包含候选人档案的新增经历字段模板", () => {
    const templates = listExtractableFieldPathTemplates();

    expect(templates).toEqual(expect.arrayContaining([
      "awards[].name",
      "awards[].date",
      "campus[].name",
      "publications[].title",
      "languages[].name",
      "languages[].proficiency",
      "languages[].speakingListening",
      "languages[].readingWriting",
      "projects[].url"
    ]));
  });

  it("只允许注册表中的规范具体路径", () => {
    expect(isAllowedExtractedFieldPath("awards[0].name")).toBe(true);
    expect(isAllowedExtractedFieldPath("campus[12].description")).toBe(true);
    expect(isAllowedExtractedFieldPath("publications[1].title")).toBe(true);
    expect(isAllowedExtractedFieldPath("languages[0].name")).toBe(true);
    expect(isAllowedExtractedFieldPath("languages[0].readingWriting")).toBe(true);

    expect(isAllowedExtractedFieldPath("awards[0].unknown")).toBe(false);
    expect(isAllowedExtractedFieldPath("awards[-1].name")).toBe(false);
    expect(isAllowedExtractedFieldPath("awards[x].name")).toBe(false);
    expect(isAllowedExtractedFieldPath("application.jobSpecific")).toBe(false);
  });
});
