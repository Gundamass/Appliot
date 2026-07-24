import { describe, expect, it } from "vitest";
import { AdapterHealthResponseSchema, AdapterStatusSchema } from "./health.js";

describe("adapter health contracts", () => {
  it("accepts only the stable public state and code vocabulary", () => {
    const states = ["unconfigured", "configured", "checking", "ready", "unavailable", "invalid"];
    const codes = ["not_configured", "not_checked", "offline", "not_ready", "contract_mismatch"];

    for (const state of states) {
      expect(AdapterStatusSchema.parse({ id: "deepseek", state })).toEqual({ id: "deepseek", state });
    }
    for (const code of codes) {
      expect(AdapterStatusSchema.parse({ id: "embedding", state: "unavailable", code })).toEqual({
        id: "embedding", state: "unavailable", code
      });
    }
  });

  it("rejects secret-bearing or unstable public fields", () => {
    expect(() => AdapterStatusSchema.parse({
      id: "ocr",
      state: "unavailable",
      code: "offline",
      url: "http://127.0.0.1:43121",
      error: "token=test-token",
      gpu: "GPU 5"
    })).toThrow();
    expect(() => AdapterStatusSchema.parse({ id: "ocr", state: "broken", code: "connection_refused" })).toThrow();
  });

  it("requires one safe status per adapter in the response", () => {
    expect(AdapterHealthResponseSchema.parse([
      { id: "deepseek", state: "configured", model: "deepseek-v4-flash", code: "not_checked" },
      { id: "embedding", state: "ready", model: "Qwen/Qwen3-Embedding-8B", modelRevision: "revision" },
      { id: "ocr", state: "unconfigured", code: "not_configured" }
    ])).toHaveLength(3);
  });
});
