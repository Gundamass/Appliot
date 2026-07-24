import { describe, expect, it, vi } from "vitest";
import {
  OCR_MODEL,
  OCR_REVISION,
  RemoteOcrEngine,
  RemoteOcrError,
  type RemoteOcrConfig
} from "./remote-ocr-engine.js";

const TOKEN = "test-token";
const RESPONSE_SECRET = "worker-response-secret";
const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const JPEG_BYTES = Uint8Array.from([255, 216, 255, 224, 0]);

function testConfig(overrides: Partial<RemoteOcrConfig> = {}): RemoteOcrConfig {
  return {
    apiToken: TOKEN,
    baseUrl: "http://127.0.0.1:43121",
    model: OCR_MODEL,
    modelRevision: OCR_REVISION,
    timeoutMs: 10,
    ...overrides
  };
}

function ocrResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    text: "# Resume\nAda Lovelace",
    model: OCR_MODEL,
    modelRevision: OCR_REVISION,
    mode: "document_to_markdown",
    elapsedMs: 1200,
    ...overrides
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function fakeFetch(outcomes: Array<Response | Error>): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const next = outcomes.shift();
    if (!next) throw new Error("Unexpected fetch call");
    if (next instanceof Error) throw next;
    return next.clone();
  });
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

describe("RemoteOcrEngine", () => {
  it("sends one PNG page and returns pinned Markdown output", async () => {
    const fetch = fakeFetch([ocrResponse({ text: " \n# Resume\nAda Lovelace\n " })]);
    const engine = new RemoteOcrEngine(testConfig(), { fetch: fetch as typeof globalThis.fetch });

    await expect(engine.recognize(PNG_BYTES)).resolves.toBe("# Resume\nAda Lovelace");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:43121/v1/ocr", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer test-token",
        "Content-Type": "image/png"
      }),
      body: PNG_BYTES
    }));
  });

  it("sends JPEG bytes as one raw page", async () => {
    const fetch = fakeFetch([ocrResponse()]);
    const engine = new RemoteOcrEngine(testConfig(), { fetch: fetch as typeof globalThis.fetch });

    await expect(engine.recognize(JPEG_BYTES)).resolves.toBe("# Resume\nAda Lovelace");
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ "Content-Type": "image/jpeg" });
    expect(fetch.mock.calls[0]![1]!.body).toBe(JPEG_BYTES);
  });

  it.each([
    ["empty output", ocrResponse({ text: "   " })],
    ["wrong model", ocrResponse({ model: "other-model" })],
    ["wrong revision", ocrResponse({ modelRevision: "other-revision" })],
    ["wrong mode", ocrResponse({ mode: "plain_text" })],
    ["unexpected response field", ocrResponse({ extra: true })],
    ["unauthorized", new Response(RESPONSE_SECRET, { status: 401 })],
    ["payload too large", new Response(RESPONSE_SECRET, { status: 413 })]
  ])("does not retry %s or expose response data", async (_caseName, outcome) => {
    const fetch = fakeFetch([outcome]);
    const sleep = vi.fn(async () => undefined);
    const engine = new RemoteOcrEngine(testConfig(), {
      fetch: fetch as typeof globalThis.fetch,
      sleep
    });

    const error = await capture(() => engine.recognize(PNG_BYTES));

    expect(error).toBeInstanceOf(RemoteOcrError);
    expect(error).toMatchObject({ kind: outcome instanceof Response && outcome.status === 401 ? "authentication" : "response" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(errorText(error)).not.toContain(TOKEN);
    expect(errorText(error)).not.toContain(RESPONSE_SECRET);
  });

  it("rejects bytes that are neither PNG nor JPEG before requesting OCR", async () => {
    const fetch = fakeFetch([ocrResponse()]);
    const engine = new RemoteOcrEngine(testConfig(), { fetch: fetch as typeof globalThis.fetch });

    await expect(engine.recognize(Uint8Array.from([0, 1, 2]))).rejects.toMatchObject({ kind: "input" });
    await expect(engine.recognize("https://example.test/page.png" as unknown as Uint8Array)).rejects.toMatchObject({ kind: "input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["network failure", new Error("network-secret")],
    ["server error", new Response(RESPONSE_SECRET, { status: 500 })]
  ])("retries %s once through the injected sleep boundary", async (_caseName, outcome) => {
    const fetch = fakeFetch([outcome, outcome]);
    const sleep = vi.fn(async () => undefined);
    const engine = new RemoteOcrEngine(testConfig(), {
      fetch: fetch as typeof globalThis.fetch,
      sleep
    });

    const error = await capture(() => engine.recognize(PNG_BYTES));

    expect(error).toBeInstanceOf(RemoteOcrError);
    expect(error).toMatchObject({ kind: outcome instanceof Error ? "network" : "response" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(errorText(error)).not.toContain(TOKEN);
    expect(errorText(error)).not.toContain(RESPONSE_SECRET);
    expect(errorText(error)).not.toContain("network-secret");
  });

  it("times out one request attempt at a time and retries once", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => {
          reject(new DOMException("timeout-secret", "AbortError"));
        }, { once: true });
      }));
      const sleep = vi.fn(async () => undefined);
      const engine = new RemoteOcrEngine(testConfig(), {
        fetch: fetch as typeof globalThis.fetch,
        sleep
      });
      const operation = capture(() => engine.recognize(PNG_BYTES));

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);

      const error = await operation;
      expect(error).toMatchObject({ kind: "timeout" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(errorText(error)).not.toContain("timeout-secret");
      expect(errorText(error)).not.toContain(TOKEN);
    } finally {
      vi.useRealTimers();
    }
  });
});
