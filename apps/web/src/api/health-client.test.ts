import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthApi } from "./health-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("HealthApi HTTP contract", () => {
  it("fetches and strictly parses safe adapter statuses", async () => {
    const payload = [
      { id: "deepseek", state: "configured", model: "deepseek-v4-flash", code: "not_checked" },
      { id: "embedding", state: "unavailable", code: "offline" },
      { id: "ocr", state: "ready", model: "ocr", modelRevision: "revision" }
    ];
    const fetchMock = vi.fn(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createHealthApi().getStatuses()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/health/adapters", { method: "GET" });
  });

  it("rejects secret-bearing fields even from a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([
      { id: "deepseek", state: "configured", code: "not_checked" },
      { id: "embedding", state: "unavailable", code: "offline", url: "http://127.0.0.1" },
      { id: "ocr", state: "unconfigured", code: "not_configured" }
    ])));

    await expect(createHealthApi().getStatuses()).rejects.toThrow();
  });
});
