import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const QWEN_REVISION = "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af";
const OCR_REVISION = "aaa02f3811945a91062062994c5c4a3f4c0af2b0";

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

  it("rejects blank max retries but accepts the explicit zero value", () => {
    expect(loadConfig({ DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MAX_RETRIES: "0" }).deepseek?.maxRetries)
      .toBe(0);
    expect(() => loadConfig({ DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MAX_RETRIES: "" }))
      .toThrow("DEEPSEEK_MAX_RETRIES");
    expect(() => loadConfig({ DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MAX_RETRIES: "   " }))
      .toThrow("DEEPSEEK_MAX_RETRIES");
  });

  it("loads complete embedding and OCR groups", () => {
    const config = loadConfig({
      EMBEDDING_BASE_URL: "http://127.0.0.1:18080",
      EMBEDDING_API_TOKEN: "embedding-test-token",
      EMBEDDING_MODEL: "Qwen/Qwen3-Embedding-8B",
      EMBEDDING_MODEL_REVISION: QWEN_REVISION,
      EMBEDDING_DIMENSIONS: "4096",
      OCR_BASE_URL: "http://127.0.0.1:43121",
      OCR_API_TOKEN: "ocr-test-token",
      OCR_MODEL: "deepseek-ai/DeepSeek-OCR-2",
      OCR_MODEL_REVISION: OCR_REVISION,
      OCR_TIMEOUT_MS: "180000"
    });

    expect(config.embedding).toMatchObject({
      baseUrl: "http://127.0.0.1:18080",
      model: "Qwen/Qwen3-Embedding-8B",
      modelRevision: QWEN_REVISION,
      dimensions: 4096,
      timeoutMs: 60_000
    });
    expect(config.ocr).toMatchObject({
      baseUrl: "http://127.0.0.1:43121",
      model: "deepseek-ai/DeepSeek-OCR-2",
      modelRevision: OCR_REVISION,
      timeoutMs: 180_000
    });
  });

  it("allows absent remote groups but rejects partial groups without reflecting secrets", () => {
    expect(loadConfig({}).embedding).toBeUndefined();
    expect(loadConfig({}).ocr).toBeUndefined();

    const secret = "do-not-reflect-remote-secret";
    const error = captureError(() => loadConfig({
      EMBEDDING_API_TOKEN: secret,
      OCR_API_TOKEN: secret
    }));

    expect(error).toContain("EMBEDDING_BASE_URL");
    expect(error).toContain("OCR_BASE_URL");
    expect(error).not.toContain(secret);
  });

  it("rejects remote URLs outside the configured loopback tunnels", () => {
    for (const baseUrl of [
      "https://127.0.0.1:18080",
      "http://localhost:43121",
      "http://127.0.0.1:43121",
      "http://example.com:18080",
      "http://token@127.0.0.1:18080"
    ]) {
      expect(() => loadConfig({ EMBEDDING_BASE_URL: baseUrl })).toThrow("EMBEDDING_BASE_URL");
    }
  });

  it("rejects invalid remote dimensions and timeouts", () => {
    expect(() => loadConfig({ EMBEDDING_DIMENSIONS: "0" })).toThrow("EMBEDDING_DIMENSIONS");
    expect(() => loadConfig({ EMBEDDING_TIMEOUT_MS: "NaN" })).toThrow("EMBEDDING_TIMEOUT_MS");
    expect(() => loadConfig({ OCR_TIMEOUT_MS: "0" })).toThrow("OCR_TIMEOUT_MS");
  });
});
