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

  it("normalizes a public HTTPS URL and removes its fragment", async () => {
    await expect(validatePublicHttpsUrl(
      "https://Talent.Baidu.com/jobs#apply",
      publicDns
    )).resolves.toEqual({
      url: "https://talent.baidu.com/jobs",
      domain: "talent.baidu.com"
    });
  });
});
