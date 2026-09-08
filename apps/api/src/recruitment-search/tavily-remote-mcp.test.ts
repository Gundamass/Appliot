import { describe, expect, it, vi } from "vitest";
import type { TavilyRemoteMcpConfig } from "../config.js";
import {
  createTavilyRecruitmentSiteSearch,
  TavilyTransportError
} from "./tavily-remote-mcp.js";

const config: TavilyRemoteMcpConfig = {
  apiKey: "tvly-test-secret",
  endpoint: "https://mcp.tavily.com/mcp/",
  timeoutMs: 10_000,
  maxRetries: 1
};

describe("Tavily Remote MCP recruitment search", () => {
  it("calls only tavily_search with fixed privacy-preserving parameters", async () => {
    const callTool = vi.fn(async () => ({ content: [{
      type: "text",
      text: JSON.stringify({
        results: [{
          title: "百度校园招聘",
          url: "https://talent.baidu.com/#jobs",
          content: "招聘岗位",
          score: 0.91
        }]
      })
    }] }));
    const search = createTavilyRecruitmentSiteSearch(config, {
      callTool,
      resolveHostname: async () => ["220.181.7.203"]
    });

    await expect(search.search({ companyName: "百度", recruitmentType: "campus" }))
      .resolves.toMatchObject({
        query: "百度 校园招聘 招聘 官网",
        candidates: [{ source: "tavily", domain: "talent.baidu.com" }]
      });
    expect(callTool).toHaveBeenCalledWith("tavily_search", {
      query: "百度 校园招聘 招聘 官网",
      search_depth: "basic",
      topic: "general",
      max_results: 5,
      include_images: false,
      include_raw_content: false
    }, 10_000);
  });

  it("returns at most three candidates and ignores unsafe or duplicate results", async () => {
    const callTool = vi.fn(async () => ({ content: [{
      type: "text",
      text: JSON.stringify({
        results: [
          { title: "t".repeat(170), url: "https://jobs.example.com/a#first", content: "extract crawl 说明" + "s".repeat(550), score: 0.8 },
          { title: "duplicate", url: "https://jobs.example.com/a#second", content: "duplicate", score: 0.7 },
          { title: "unsafe", url: "http://unsafe.example.com/", content: "not allowed", score: 0.6 },
          { title: "second", url: "https://jobs.example.com/b", content: "second", score: 0.5 },
          { title: "third", url: "https://jobs.example.com/c", content: "third", score: 0.4 }
        ]
      })
    }] }));
    const search = createTavilyRecruitmentSiteSearch(config, {
      callTool,
      resolveHostname: async () => ["220.181.7.203"]
    });

    const result = await search.search({ companyName: "百度", recruitmentType: "campus" });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.map((candidate) => candidate.url)).toEqual([
      "https://jobs.example.com/a",
      "https://jobs.example.com/b",
      "https://jobs.example.com/c"
    ]);
    expect(result.candidates[0]).toMatchObject({
      title: "t".repeat(160),
      snippet: ("extract crawl 说明" + "s".repeat(550)).slice(0, 500),
      source: "tavily",
      sourceScore: 0.8
    });
  });

  it("rejects a response text content larger than 256 KiB", async () => {
    const callTool = vi.fn(async () => ({ content: [{
      type: "text",
      text: "x".repeat(256 * 1024 + 1)
    }] }));
    const search = createTavilyRecruitmentSiteSearch(config, { callTool });

    await expect(search.search({ companyName: "百度", recruitmentType: "campus" }))
      .rejects.toMatchObject({ message: "TAVILY_PROTOCOL_ERROR" });
  });

  it("returns NO_SAFE_CANDIDATE when every candidate fails public URL validation", async () => {
    const callTool = vi.fn(async () => ({ content: [{
      type: "text",
      text: JSON.stringify({
        results: [{
          title: "private",
          url: "https://jobs.example.com/",
          content: "private DNS"
        }]
      })
    }] }));
    const search = createTavilyRecruitmentSiteSearch(config, {
      callTool,
      resolveHostname: async () => ["10.0.0.2"]
    });

    await expect(search.search({ companyName: "百度", recruitmentType: "campus" }))
      .rejects.toMatchObject({ message: "NO_SAFE_CANDIDATE" });
  });

  it.each([
    [new TavilyTransportError("timeout", 408), "TAVILY_TIMEOUT", 1],
    [new TavilyTransportError("rate_limited", 429), "TAVILY_UNAVAILABLE", 2],
    [new TavilyTransportError("server_error", 503), "TAVILY_UNAVAILABLE", 2],
    [new TavilyTransportError("network"), "TAVILY_UNAVAILABLE", 2],
    [new TavilyTransportError("http", 400), "TAVILY_PROTOCOL_ERROR", 1],
    [new Error("malformed"), "TAVILY_PROTOCOL_ERROR", 1]
  ])("maps failures without leaking the API key", async (cause, code, calls) => {
    const secret = "tvly-should-never-leak";
    const callTool = vi.fn().mockRejectedValue(cause);
    const delay = vi.fn(async () => undefined);
    const search = createTavilyRecruitmentSiteSearch({ ...config, apiKey: secret }, {
      callTool,
      delay
    });

    const error = await search.search({ companyName: "百度", recruitmentType: "campus" })
      .then(() => undefined, (value) => value as Error);
    expect(error?.message).toBe(code);
    expect(String(error)).not.toContain(secret);
    expect(callTool).toHaveBeenCalledTimes(calls);
    expect(delay).toHaveBeenCalledTimes(calls === 2 ? 1 : 0);
  });
});
