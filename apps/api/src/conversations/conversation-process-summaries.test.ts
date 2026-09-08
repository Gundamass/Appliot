import { describe, expect, it } from "vitest";
import { summarizeToolResult, summarizeToolStart } from "./conversation-process-summaries.js";

describe("conversation process summaries", () => {
  it("keeps Tavily summaries allowlisted when raw secret-shaped fields are present", () => {
    const summary = summarizeToolStart("discover_recruitment_site", {
      company: "百度",
      recruitmentType: "campus",
      tavilyApiKey: "secret-value",
      rawResponse: { authorization: "Bearer secret-value" }
    });

    expect(summary).toEqual({
      name: "tavily_search",
      input: [
        { label: "公司", value: "百度" },
        { label: "招聘类型", value: "校园招聘" }
      ]
    });
    expect(JSON.stringify(summary)).not.toMatch(/secret-value|authorization|rawResponse/i);
  });

  it("summarizes result counts instead of copying cards or raw tool results", () => {
    const summary = summarizeToolResult("discover_recruitment_site", {
      company: "百度",
      recruitmentType: "campus"
    }, {
      cards: [],
      recruitmentSearch: {
        query: "百度校园招聘 招聘 官网",
        candidates: [{
          title: "百度校园招聘",
          url: "https://talent.baidu.com/jobs/list",
          domain: "talent.baidu.com",
          snippet: "校园招聘",
          source: "tavily"
        }]
      }
    });

    expect(summary.result).toBe("找到 1 个候选招聘入口");
    expect(JSON.stringify(summary)).not.toContain("talent.baidu.com/jobs/list");
  });
});
