import { describe, expect, it } from "vitest";
import {
  RecruitmentSearchRequestSchema,
  RecruitmentSiteSearchResultSchema,
  VerifiedRecruitmentSiteSchema
} from "./recruitment-search.js";

describe("recruitment search contracts", () => {
  it("accepts only bounded non-personal search input and at most three candidates", () => {
    expect(RecruitmentSearchRequestSchema.parse({
      companyName: "百度",
      recruitmentType: "campus"
    })).toEqual({ companyName: "百度", recruitmentType: "campus" });
    expect(() => RecruitmentSearchRequestSchema.parse({
      companyName: "百度",
      recruitmentType: "campus",
      resumeText: "secret"
    })).toThrow();
    expect(() => RecruitmentSiteSearchResultSchema.parse({
      query: "百度 校园招聘 招聘 官网",
      candidates: Array.from({ length: 4 }, (_, index) => ({
        title: `候选 ${index}`,
        url: `https://jobs${index}.example.com/`,
        domain: `jobs${index}.example.com`,
        snippet: "招聘入口",
        source: "tavily"
      }))
    })).toThrow();
  });

  it("keeps a selected site separate from search results", () => {
    expect(VerifiedRecruitmentSiteSchema.parse({
      company: "百度",
      recruitmentType: "campus",
      query: "百度 校园招聘 招聘 官网",
      title: "百度校园招聘",
      url: "https://talent.baidu.com/",
      domain: "talent.baidu.com",
      snippet: "校园招聘岗位",
      source: "tavily",
      sourceScore: 0.92
    })).toMatchObject({ company: "百度", source: "tavily" });
  });
});
