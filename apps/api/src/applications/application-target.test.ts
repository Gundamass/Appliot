import { describe, expect, it } from "vitest";
import { ApplicationTargetError, deterministicApplicationTaskId, prepareApplicationTarget } from "./application-target.js";

const publicDns = async () => ["220.181.7.203"];
const polluted = "https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440%E8%BF%99%E4%B8%AA%E9%A1%B5%E9%9D%A2%E5%8F%AF%E4%BB%A5%E6%8A%95%E9%80%92%E5%90%97";
const clean = "https://wondersharecampus.zhiye.com/form?fromPage=job&jobAdId=1e15df19-c887-41f5-b632-3845af9b5131&shareId=16002765-e0e5-4238-a46a-4f8b717777fc&userId=125079440";

describe("application target preparation", () => {
  it("recovers the exact polluted Wondershare URL and derives a UUID", async () => {
    await expect(prepareApplicationTarget(polluted, "conversation:c1", publicDns)).resolves.toMatchObject({
      applicationUrl: clean,
      boundary: "recovered_encoded_suffix",
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    });
  });

  it("is deterministic for identity and canonical URL", async () => {
    const recovered = await prepareApplicationTarget(polluted, "conversation:c1", publicDns);
    const explicit = await prepareApplicationTarget(clean, "conversation:c1", publicDns);
    const other = await prepareApplicationTarget(clean, "conversation:c2", publicDns);
    expect(recovered.id).toBe(explicit.id);
    expect(other.id).not.toBe(explicit.id);
    expect(deterministicApplicationTaskId("conversation:c1", clean)).toBe(explicit.id);
  });

  it.each([
    "https://jobs.example.com/%E5%B2%97%E4%BD%8D/%E5%89%8D%E7%AB%AF",
    "https://jobs.example.com/search?keyword=%E5%89%8D%E7%AB%AF",
    "https://jobs.example.com/apply?candidateId=abc%E5%BC%A0%E4%B8%89",
    "https://jobs.example.com/apply?id=ABC_123-xy&mode=fast",
    "https://jobs.example.com/apply?token=abc%e5%bc%a0%e4%b8%89"
  ])("retains a legitimate URL boundary: %s", async (url) => {
    const target = await prepareApplicationTarget(url, "direct", publicDns);
    expect(target.applicationUrl).toBe(url);
    expect(target.boundary).toBe("explicit");
  });

  it.each([
    ["http://jobs.example.com/apply", "invalid_application_url"],
    ["https://user:secret@jobs.example.com/apply", "unsafe_application_url"],
    ["https://127.0.0.1/apply", "unsafe_application_url"],
    ["https://localhost/apply", "unsafe_application_url"],
    ["https://jobs.example.com/%ZZ", "invalid_application_url"],
    ["https://jobs.example.com/one https://jobs.example.com/two", "invalid_application_url"]
  ] as const)("rejects an invalid or unsafe target: %s", async (url, code) => {
    await expect(prepareApplicationTarget(url, "direct", publicDns)).rejects.toMatchObject({ code });
  });

  it("rejects a hostname resolving to a private address without exposing the URL", async () => {
    const raw = "https://jobs.example.com/apply?token=secret";
    const error = await prepareApplicationTarget(raw, "direct", async () => ["192.168.1.2"]).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApplicationTargetError);
    expect(error).toMatchObject({ code: "unsafe_application_url", message: "unsafe_application_url" });
    expect(String(error)).not.toContain("secret");
  });
});
