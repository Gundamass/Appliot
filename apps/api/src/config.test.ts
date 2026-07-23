import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

function captureError(action: () => unknown): string {
  try {
    action();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("API configuration", () => {
  it("loads core defaults and a complete DeepSeek group", () => {
    expect(loadConfig({ DEEPSEEK_API_KEY: "test-key" })).toMatchObject({
      databaseFile: "data/resume-assistant.sqlite",
      host: "127.0.0.1",
      port: 43120,
      deepseek: {
        apiKey: "test-key",
        baseUrl: "https://api.deepseek.com",
        defaultModel: "deepseek-v4-flash",
        escalationModel: "deepseek-v4-pro",
        thinking: "disabled",
        timeoutMs: 60_000,
        maxRetries: 2
      }
    });
  });

  it("allows an entirely absent adapter but rejects a partial adapter", () => {
    expect(loadConfig({}).deepseek).toBeUndefined();
    expect(() => loadConfig({ DEEPSEEK_BASE_URL: "https://api.deepseek.com" }))
      .toThrow("DEEPSEEK_API_KEY");
  });

  it("does not include secret values in validation errors", () => {
    const secret = "do-not-print-this";
    expect(captureError(() => loadConfig({ DEEPSEEK_API_KEY: secret, DEEPSEEK_TIMEOUT_MS: "NaN" })))
      .not.toContain(secret);
  });
});
