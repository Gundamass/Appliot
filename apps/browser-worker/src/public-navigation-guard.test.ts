import { describe, expect, it, vi } from "vitest";
import { createPublicNavigationGuardHandler } from "./public-navigation-guard.js";

function routeFor(url: string) {
  return {
    request: () => ({
      url: () => url,
      isNavigationRequest: () => true,
      resourceType: () => "document"
    }),
    continue: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined)
  };
}

describe("public recruitment navigation guard", () => {
  const publicDns = vi.fn(async () => ["220.181.7.203"]);

  it("allows a public HTTPS document navigation", async () => {
    const route = routeFor("https://jobs.example.com/apply");
    const handler = createPublicNavigationGuardHandler(publicDns);

    await handler(route as never);

    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.abort).not.toHaveBeenCalled();
  });

  it("aborts a private redirect before the request is continued", async () => {
    const route = routeFor("https://10.0.0.2/apply");
    const handler = createPublicNavigationGuardHandler(publicDns);

    await expect(handler(route as never)).rejects.toThrow("unsafe_recruitment_redirect");
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continue).not.toHaveBeenCalled();
  });

  it.each([
    "http://jobs.example.com/apply",
    "https://user:pass@jobs.example.com/apply",
    "https://localhost/apply"
  ])("blocks unsafe navigation %s", async (url) => {
    const route = routeFor(url);
    const handler = createPublicNavigationGuardHandler(publicDns);

    await expect(handler(route as never)).rejects.toThrow("unsafe_recruitment_redirect");
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continue).not.toHaveBeenCalled();
  });

  it("blocks mixed public and private DNS answers", async () => {
    const route = routeFor("https://jobs.example.com/apply");
    const handler = createPublicNavigationGuardHandler(async () => ["220.181.7.203", "10.0.0.2"]);

    await expect(handler(route as never)).rejects.toThrow("unsafe_recruitment_redirect");
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
  });
});
