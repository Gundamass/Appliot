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
  it("enables encrypted ATS adapter debug retention with a 24 hour default", () => {
    const encryptionKey = Buffer.alloc(32, 7);

    expect(loadConfig({
      ATS_ADAPTER_DEBUG_RAW: "1",
      ATS_ADAPTER_DEBUG_KEY_BASE64: encryptionKey.toString("base64")
    }).atsAdapterDebug).toEqual({
      enabled: true,
      encryptionKey,
      ttlHours: 24
    });
    expect(loadConfig({}).atsAdapterDebug).toBeUndefined();
  });

  it("rejects invalid ATS adapter debug keys, flags, and retention without reflecting the key", () => {
    const secret = Buffer.alloc(31, 5).toString("base64");
    const keyError = captureError(() => loadConfig({
      ATS_ADAPTER_DEBUG_RAW: "1",
      ATS_ADAPTER_DEBUG_KEY_BASE64: secret
    }));
    expect(keyError).toContain("ATS_ADAPTER_DEBUG_KEY_BASE64");
    expect(keyError).not.toContain(secret);

    expect(() => loadConfig({ ATS_ADAPTER_DEBUG_RAW: "true" })).toThrow("ATS_ADAPTER_DEBUG_RAW");
    expect(() => loadConfig({ ATS_ADAPTER_DEBUG_RAW: "1", ATS_ADAPTER_DEBUG_TTL_HOURS: "0" }))
      .toThrow("ATS_ADAPTER_DEBUG_TTL_HOURS");
    expect(() => loadConfig({ ATS_ADAPTER_DEBUG_RAW: "1", ATS_ADAPTER_DEBUG_TTL_HOURS: "169" }))
      .toThrow("ATS_ADAPTER_DEBUG_TTL_HOURS");
    expect(loadConfig({
      ATS_ADAPTER_DEBUG_RAW: "1",
      ATS_ADAPTER_DEBUG_KEY_BASE64: Buffer.alloc(32, 8).toString("base64"),
      ATS_ADAPTER_DEBUG_TTL_HOURS: "168"
    }).atsAdapterDebug?.ttlHours).toBe(168);
  });

  it("loads core defaults and a complete DeepSeek group", () => {
    expect(loadConfig({ DEEPSEEK_API_KEY: "test-key" })).toMatchObject({
      databaseFile: "data/resume-assistant.sqlite",
      host: "127.0.0.1",
      port: 43120,
      langsmith: { enabled: false, project: "resume-assistant", maxAttempts: 3 },
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

  it("loads Tavily Remote MCP from an API key without exposing the key in errors", () => {
    expect(loadConfig({ TAVILY_API_KEY: "tvly-test-secret" })).toMatchObject({
      tavily: {
        apiKey: "tvly-test-secret",
        endpoint: "https://mcp.tavily.com/mcp/",
        timeoutMs: 10_000,
        maxRetries: 1
      }
    });

    const secret = "tvly-should-never-leak";
    const message = captureError(() => loadConfig({
      TAVILY_API_KEY: secret,
      TAVILY_MCP_TIMEOUT_MS: "invalid"
    }));
    expect(message).toContain("TAVILY_MCP_TIMEOUT_MS");
    expect(message).not.toContain(secret);
  });

  it("keeps Tavily disabled when no TAVILY variables are present and rejects unsafe endpoints", () => {
    expect(loadConfig({}).tavily).toBeUndefined();
    expect(() => loadConfig({
      TAVILY_API_KEY: "key",
      TAVILY_MCP_ENDPOINT: "http://localhost:3000/mcp"
    })).toThrow("TAVILY_MCP_ENDPOINT");
    expect(() => loadConfig({ TAVILY_MCP_TIMEOUT_MS: "10000" }))
      .toThrow("TAVILY_API_KEY");
  });

  it("keeps LangSmith disabled by default and validates credentials only when enabled", () => {
    expect(loadConfig({}).langsmith).toEqual({
      enabled: false,
      project: "resume-assistant",
      maxAttempts: 3
    });
    expect(() => loadConfig({ LANGSMITH_TRACING_ENABLED: "true" }))
      .toThrow("LANGSMITH_API_KEY");
    expect(loadConfig({
      LANGSMITH_TRACING_ENABLED: "true",
      LANGSMITH_API_KEY: "test-key",
      LANGSMITH_ENDPOINT: "https://api.smith.langchain.com",
      LANGSMITH_PROJECT: "agent-review",
      LANGSMITH_MAX_ATTEMPTS: "5"
    }).langsmith).toEqual({
      enabled: true,
      apiKey: "test-key",
      endpoint: "https://api.smith.langchain.com",
      project: "agent-review",
      maxAttempts: 5
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

  it("loads a local LightRAG retrieval worker only from its complete configuration group", () => {
    expect(loadConfig({
      LIGHTRAG_RETRIEVAL_API_TOKEN: "lightrag-test-token",
      LIGHTRAG_RETRIEVAL_BASE_URL: "http://127.0.0.1:43122",
      LIGHTRAG_RETRIEVAL_TENANT_SCOPE: "tenant-a",
      LIGHTRAG_RETRIEVAL_TIMEOUT_MS: "15000"
    }).lightRag).toEqual({
      apiToken: "lightrag-test-token",
      baseUrl: "http://127.0.0.1:43122",
      tenantScope: "tenant-a",
      timeoutMs: 15_000
    });
    expect(loadConfig({}).lightRag).toBeUndefined();
    expect(() => loadConfig({ LIGHTRAG_RETRIEVAL_BASE_URL: "http://127.0.0.1:43122" }))
      .toThrow("LIGHTRAG_RETRIEVAL_API_TOKEN");
    expect(() => loadConfig({
      LIGHTRAG_RETRIEVAL_API_TOKEN: "lightrag-test-token",
      LIGHTRAG_RETRIEVAL_BASE_URL: "http://example.test:43122",
      LIGHTRAG_RETRIEVAL_TENANT_SCOPE: "tenant-a"
    })).toThrow("LIGHTRAG_RETRIEVAL_BASE_URL");
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

  it("rejects remote tunnel URLs with paths, queries, or fragments without reflecting secrets", () => {
    const secret = "remote-url-secret";
    for (const [variable, baseUrl] of [
      ["EMBEDDING_BASE_URL", "http://127.0.0.1:18080/v1"],
      ["EMBEDDING_BASE_URL", "http://localhost:18080/?token=remote-url-secret"],
      ["EMBEDDING_BASE_URL", "http://127.0.0.1:18080?"],
      ["OCR_BASE_URL", "http://127.0.0.1:43121/#remote-url-secret"],
      ["OCR_BASE_URL", "http://127.0.0.1:43121#"]
    ] as const) {
      const error = captureError(() => loadConfig({ [variable]: baseUrl }));
      expect(error).toContain(variable);
      expect(error).not.toContain(secret);
    }
  });

  it("accepts API port boundaries and rejects ports outside the TCP range", () => {
    expect(loadConfig({ API_PORT: "1" }).port).toBe(1);
    expect(loadConfig({ API_PORT: "65535" }).port).toBe(65535);
    for (const port of ["0", "65536", "1.5", "NaN"]) {
      expect(() => loadConfig({ API_PORT: port })).toThrow("API_PORT");
    }
  });

  it("rejects invalid remote dimensions and timeouts", () => {
    expect(() => loadConfig({ EMBEDDING_DIMENSIONS: "0" })).toThrow("EMBEDDING_DIMENSIONS");
    expect(() => loadConfig({ EMBEDDING_TIMEOUT_MS: "NaN" })).toThrow("EMBEDDING_TIMEOUT_MS");
    expect(() => loadConfig({ OCR_TIMEOUT_MS: "0" })).toThrow("OCR_TIMEOUT_MS");
  });
});
