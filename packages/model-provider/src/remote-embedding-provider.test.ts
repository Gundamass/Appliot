import { describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_INSTRUCTION_VERSION,
  EMBEDDING_QUERY_INSTRUCTION,
  RemoteEmbeddingProvider,
  RemoteEmbeddingError,
  type RemoteEmbeddingConfig
} from "./remote-embedding-provider.js";

const MODEL = "Qwen/Qwen3-Embedding-8B";
const REVISION = "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af";
const TOKEN = "embedding-test-token";
const RESPONSE_SECRET = "response-body-with-fake-token";

function testConfig(overrides: Partial<RemoteEmbeddingConfig> = {}): RemoteEmbeddingConfig {
  return {
    apiToken: TOKEN,
    baseUrl: "http://127.0.0.1:18080",
    model: MODEL,
    modelRevision: REVISION,
    dimensions: 4,
    timeoutMs: 10,
    ...overrides
  };
}

function responseFor(vectors: number[][], dimensions = 4, overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    model: MODEL,
    modelRevision: REVISION,
    dimensions,
    data: vectors.map((embedding, index) => ({ index, embedding })),
    ...overrides
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function embeddingFetch(outcomes: Array<Response | Error>): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const next = outcomes.shift();
    if (!next) throw new Error("Unexpected fetch call");
    if (next instanceof Error) throw next;
    return next.clone();
  });
}

function requestInputs(fetch: ReturnType<typeof vi.fn>): string[][] {
  return fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string).input);
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function capture(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("RemoteEmbeddingProvider", () => {
  it("keeps documents raw and prefixes only queries", async () => {
    const fetch = embeddingFetch([
      responseFor([[1, 0, 0, 0]], 4),
      responseFor([[0, 1, 0, 0]], 4)
    ]);
    const provider = new RemoteEmbeddingProvider(testConfig(), { fetch: fetch as typeof globalThis.fetch });

    await provider.embedDocuments(["React experience"]);
    await provider.embedQuery("frontend role");

    expect(requestInputs(fetch)).toEqual([
      ["React experience"],
      [`Instruct: ${EMBEDDING_QUERY_INSTRUCTION}\nQuery: frontend role`]
    ]);
    expect(EMBEDDING_INSTRUCTION_VERSION).toBe("resume-fact-query-v1");
  });

  it("sends the pinned model to the local worker with bearer authorization", async () => {
    const fetch = embeddingFetch([responseFor([[1, 0, 0, 0]])]);
    const provider = new RemoteEmbeddingProvider(testConfig(), { fetch: fetch as typeof globalThis.fetch });

    await expect(provider.embedDocuments(["resume fact"])).resolves.toEqual([[1, 0, 0, 0]]);

    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:18080/v1/embeddings", expect.objectContaining({
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      }
    }));
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      model: MODEL,
      input: ["resume fact"]
    });
  });

  it("sorts indexed vectors and requires contiguous indexes", async () => {
    const fetch = embeddingFetch([
      responseFor([], 4, {
        data: [
          { index: 1, embedding: [0, 1, 0, 0] },
          { index: 0, embedding: [1, 0, 0, 0] }
        ]
      })
    ]);
    const provider = new RemoteEmbeddingProvider(testConfig(), { fetch: fetch as typeof globalThis.fetch });

    await expect(provider.embedDocuments(["first", "second"])).resolves.toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0]
    ]);
  });

  it("rejects non-contiguous response indexes", async () => {
    const fetch = embeddingFetch([
      responseFor([], 4, {
        data: [
          { index: 0, embedding: [1, 0, 0, 0] },
          { index: 2, embedding: [0, 1, 0, 0] }
        ]
      })
    ]);
    const provider = new RemoteEmbeddingProvider(testConfig(), { fetch: fetch as typeof globalThis.fetch });

    await expect(provider.embedDocuments(["first", "second"])).rejects.toMatchObject({ kind: "response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unexpected top-level field", { unexpected: true }],
    ["unexpected data-entry field", {
      data: [{ index: 0, embedding: [1, 0, 0, 0], unexpected: true }]
    }]
  ])("rejects a response with an %s", async (_caseName, overrides) => {
    const fetch = embeddingFetch([responseFor([[1, 0, 0, 0]], 4, overrides)]);
    const provider = new RemoteEmbeddingProvider(testConfig(), { fetch: fetch as typeof globalThis.fetch });

    await expect(provider.embedDocuments(["resume fact"])).rejects.toMatchObject({ kind: "response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty batch", [], "input"],
    ["blank text", ["  "], "input"],
    ["too many inputs", Array.from({ length: 33 }, () => "resume fact"), "input"],
    ["oversized input", ["x".repeat(30_001)], "input"]
  ])("rejects %s locally", async (_caseName, input, kind) => {
    const fetch = embeddingFetch([responseFor([[1, 0, 0, 0]])]);
    const provider = new RemoteEmbeddingProvider(testConfig(), { fetch: fetch as typeof globalThis.fetch });

    await expect(provider.embedDocuments(input)).rejects.toMatchObject({ kind });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong model", responseFor([[1, 0, 0, 0]], 4, { model: "other-model" }), undefined, 1, "response"],
    ["wrong revision", responseFor([[1, 0, 0, 0]], 4, { modelRevision: "other-revision" }), undefined, 1, "response"],
    ["count mismatch", responseFor([[1, 0, 0, 0]]), undefined, 1, "response"],
    ["wrong dimensions", responseFor([[1, 0, 0], [0, 1, 0]], 3), undefined, 1, "response"],
    ["NaN from injected parsed response", responseFor([[1, 0, 0, 0]]), {
      model: MODEL,
      modelRevision: REVISION,
      dimensions: 4,
      data: [
        { index: 0, embedding: [Number.NaN, 0, 0, 0] },
        { index: 1, embedding: [0, 1, 0, 0] }
      ]
    }, 1, "response"],
    ["non-unit norm", responseFor([[2, 0, 0, 0], [0, 1, 0, 0]]), undefined, 1, "response"],
    ["unauthorized", new Response(RESPONSE_SECRET, { status: 401 }), undefined, 1, "authentication"],
    ["rate limited", new Response(RESPONSE_SECRET, { status: 429 }), undefined, 3, "rate_limit"],
    ["server error", new Response(RESPONSE_SECRET, { status: 500 }), undefined, 3, "response"],
    ["other client error", new Response(RESPONSE_SECRET, { status: 400 }), undefined, 1, "response"],
    ["network error", new Error("network-failure-secret"), undefined, 3, "network"]
  ])("rejects %s without exposing worker response data", async (_caseName, outcome, parsedResponse, expectedCalls, kind) => {
    const fetch = embeddingFetch(Array.from({ length: 3 }, () => outcome as Response | Error));
    const sleep = vi.fn(async () => undefined);
    const provider = new RemoteEmbeddingProvider(testConfig(), {
      fetch: fetch as typeof globalThis.fetch,
      sleep,
      ...(parsedResponse === undefined ? {} : { parseResponse: async () => parsedResponse })
    });

    const error = await capture(() => provider.embedDocuments(["resume fact", "another fact"]));

    expect(error).toBeInstanceOf(RemoteEmbeddingError);
    expect(error).toMatchObject({ kind });
    expect(fetch).toHaveBeenCalledTimes(expectedCalls);
    expect(sleep).toHaveBeenCalledTimes(expectedCalls - 1);
    expect(errorText(error)).not.toContain(TOKEN);
    expect(errorText(error)).not.toContain(RESPONSE_SECRET);
    expect(errorText(error)).not.toContain("network-failure-secret");
  });

  it("retries aborted requests through the injected sleep boundary", async () => {
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout-secret", "AbortError")));
    }));
    const sleep = vi.fn(async () => undefined);
    const provider = new RemoteEmbeddingProvider(testConfig(), {
      fetch: fetch as typeof globalThis.fetch,
      sleep
    });

    const error = await capture(() => provider.embedDocuments(["resume fact"]));

    expect(error).toMatchObject({ kind: "timeout" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(sleep).toHaveBeenCalledWith(200);
    expect(errorText(error)).not.toContain("timeout-secret");
  });

  it("keeps the timeout active while parsing a stalled response body and retries", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        signals.push(init!.signal!);
        return responseFor([[1, 0, 0, 0]]);
      });
      const sleep = vi.fn(async () => undefined);
      const parseResponse = vi.fn(async () => new Promise<never>((_resolve, reject) => {
        signals.at(-1)?.addEventListener("abort", () => {
          reject(new DOMException("stalled-body-secret", "AbortError"));
        }, { once: true });
      }));
      const provider = new RemoteEmbeddingProvider(testConfig({ timeoutMs: 10 }), {
        fetch: fetch as typeof globalThis.fetch,
        sleep,
        parseResponse
      });
      const operation = capture(() => provider.embedDocuments(["resume fact"]));

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(parseResponse).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      const error = await operation;
      expect(error).toMatchObject({ kind: "timeout" });
      expect(errorText(error)).not.toContain("stalled-body-secret");
    } finally {
      vi.useRealTimers();
    }
  });
});
