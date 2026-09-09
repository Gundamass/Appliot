import { describe, expect, it, vi } from "vitest";
import { validatePublicHttpsUrl } from "./public-https-url.js";

describe("validatePublicHttpsUrl", () => {
  const publicDns = vi.fn(async () => ["220.181.7.203"]);

  it.each([
    "http://talent.baidu.com/jobs",
    "https://user:pass@talent.baidu.com/jobs",
    "https://localhost/jobs",
    "https://127.0.0.1/jobs",
    "https://[::1]/jobs",
    "https://jobs.local/path"
  ])("rejects unsafe URL %s", async (url) => {
    await expect(validatePublicHttpsUrl(url, publicDns)).rejects.toThrow("unsafe_recruitment_url");
  });

  it("rejects a hostname when any DNS answer is private", async () => {
    await expect(validatePublicHttpsUrl("https://jobs.example.com/", async () => [
      "203.0.113.8",
      "10.0.0.2"
    ])).rejects.toThrow("unsafe_recruitment_url");
  });

  it("normalizes a public HTTPS URL and preserves its fragment", async () => {
    await expect(validatePublicHttpsUrl(
      "https://App.Mokahr.com/campus-recruitment/whfhtx/73922#/job/a6cadf99-015c-42f6-a170-3252b540dae6/apply",
      publicDns
    )).resolves.toEqual({
      url: "https://app.mokahr.com/campus-recruitment/whfhtx/73922#/job/a6cadf99-015c-42f6-a170-3252b540dae6/apply",
      domain: "app.mokahr.com"
    });
  });
});
