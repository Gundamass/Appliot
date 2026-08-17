import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DeepSeekProviderError, DeepSeekStructuredModelProvider, type DeepSeekProviderConfig } from "./deepseek-provider.js";

const config: DeepSeekProviderConfig = {
  apiKey: "test-api-key",
  baseUrl: "https://api.deepseek.com",
  defaultModel: "deepseek-v4-flash",
  escalationModel: "deepseek-v4-pro",
  thinking: "disabled",
  timeoutMs: 10,
  maxRetries: 1
};

const FactsSchema = z.object({ facts: z.array(z.unknown()) });

function completion(content: string | null, reasoningContent?: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content, ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent }) } }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function response(status: number, body = "response-secret-content"): Response {
  return new Response(body, { status });
}

function fakeFetch(...responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const next = responses.shift();
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

describe("DeepSeekStructuredModelProvider", () => {
  it("sends JSON mode with thinking disabled and validates locally", async () => {
    const fetch = fakeFetch(completion(JSON.stringify({ facts: [] })));
    const provider = new DeepSeekStructuredModelProvider(config, { fetch: fetch as typeof globalThis.fetch, sleep: async () => undefined });

    await expect(provider.generateStructured({
      system: "Extract supported facts.",
      user: "resume text",
      schema: FactsSchema,
      jsonExample: { facts: [] }
    })).resolves.toEqual({ facts: [] });

    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
      model: "deepseek-v4-flash",
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      max_tokens: 8192
    });
    expect(JSON.stringify(fetch.mock.calls[0])).toContain("json");
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).messages[0].content).toContain('{"facts":[]}');
    expect(fetch.mock.calls[0]![0]).toBe("https://api.deepseek.com/chat/completions");
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({
      Authorization: "Bearer test-api-key",
      "Content-Type": "application/json"
    });
  });

  it("uses DeepSeek defaults when optional configuration is omitted", async () => {
    const fetch = fakeFetch(completion(JSON.stringify({ facts: [] })));
    const provider = new DeepSeekStructuredModelProvider({ apiKey: "test-api-key" }, { fetch: fetch as typeof globalThis.fetch, sleep: async () => undefined });

    await provider.generateStructured({ system: "Return json.", user: "resume", schema: FactsSchema, jsonExample: { facts: [] } });

    expect(fetch.mock.calls[0]![0]).toBe("https://api.deepseek.com/chat/completions");
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" }
    });
  });

  it("rejects invalid configuration without exposing configured values", () => {
    const secret = "configuration-secret";

    let error: unknown;
    try {
      new DeepSeekStructuredModelProvider({ apiKey: secret, timeoutMs: 0 });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ kind: "configuration" });
    expect(errorText(error)).not.toContain(secret);
  });

  it.each([
    ["empty content", [completion("")], 4, "validation", ""],
    ["malformed response JSON", [response(200, "malformed-response-secret")], 4, "response", "malformed-response-secret"],
    ["malformed JSON", [completion("malformed-secret-content")], 4, "validation", "malformed-secret-content"],
    ["schema failure", [completion(JSON.stringify({ facts: "invalid-schema-secret" }))], 4, "validation", "invalid-schema-secret"],
    ["rate limit", [response(429, "rate-limit-secret-content")], 2, "rate_limit", "rate-limit-secret-content"],
    ["retryable server error", [response(500, "server-secret-content")], 2, "response", "server-secret-content"],
    ["non-retryable client error", [response(400, "client-secret-content")], 1, "response", "client-secret-content"],
    ["network failure", [new Error("network-secret-content")], 2, "network", "network-secret-content"],
    ["response reasoning content", [completion("malformed-secret-content", "reasoning-secret-content")], 4, "validation", "reasoning-secret-content"]
  ])("%s retries deterministically and redacts sensitive response data", async (_caseName, outcomes, expectedCalls, kind, secretContent) => {
    const fetch = fakeFetch(...(outcomes as Array<Response | Error>), ...(Array.from({ length: 4 }, () => outcomes[0]!)) as Array<Response | Error>);
    const provider = new DeepSeekStructuredModelProvider(config, { fetch: fetch as typeof globalThis.fetch, sleep: async () => undefined });

    const error = await capture(() => provider.generateStructured({
      system: "Return json.",
      user: "resume",
      schema: FactsSchema,
      jsonExample: { facts: [] }
    }));

    expect(error).toBeInstanceOf(DeepSeekProviderError);
    expect(error).toMatchObject({ kind });
    expect(fetch).toHaveBeenCalledTimes(expectedCalls);
    expect(errorText(error)).not.toContain(config.apiKey);
    if (secretContent) expect(errorText(error)).not.toContain(secretContent);
    expect(errorText(error)).not.toContain("reasoning-secret-content");
  });

  it("classifies an aborted request as a retryable timeout", async () => {
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout-secret-content", "AbortError")));
    }));
    const provider = new DeepSeekStructuredModelProvider(config, { fetch: fetch as typeof globalThis.fetch, sleep: async () => undefined });

    const error = await capture(() => provider.generateStructured({
      system: "Return json.", user: "resume", schema: FactsSchema, jsonExample: { facts: [] }
    }));

    expect(error).toMatchObject({ kind: "timeout" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(errorText(error)).not.toContain("timeout-secret-content");
  });

  it("keeps one timeout active through stalled body parsing and clears every attempt timer", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const signals: AbortSignal[] = [];
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        const signal = init!.signal!;
        signals.push(signal);
        return {
          ok: true,
          json: () => new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new DOMException("stalled-body-secret", "AbortError"));
            }, { once: true });
          })
        } as unknown as Response;
      });
      const sleep = vi.fn(async () => undefined);
      const provider = new DeepSeekStructuredModelProvider(config, {
        fetch: fetch as typeof globalThis.fetch,
        sleep
      });
      const operation = capture(() => provider.generateStructured({
        system: "Return json.", user: "resume", schema: FactsSchema, jsonExample: { facts: [] }
      }));

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
      const error = await operation;
      expect(error).toMatchObject({ kind: "timeout" });
      expect(errorText(error)).not.toContain("stalled-body-secret");
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("escalates to Pro once after flash validation failures", async () => {
    const fetch = fakeFetch(
      completion("not-json"),
      completion("still-not-json"),
      completion(JSON.stringify({ facts: [] }))
    );
    const provider = new DeepSeekStructuredModelProvider(config, { fetch: fetch as typeof globalThis.fetch, sleep: async () => undefined });

    await expect(provider.generateStructured({
      system: "Return json.", user: "resume", schema: FactsSchema, jsonExample: { facts: [] }
    })).resolves.toEqual({ facts: [] });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).model).toBe("deepseek-v4-flash");
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string).model).toBe("deepseek-v4-flash");
    expect(JSON.parse(fetch.mock.calls[2]![1]!.body as string).model).toBe("deepseek-v4-pro");
  });

  it("does not escalate after retryable transport failures", async () => {
    const fetch = fakeFetch(response(500), response(500));
    const provider = new DeepSeekStructuredModelProvider(config, { fetch: fetch as typeof globalThis.fetch, sleep: async () => undefined });

    await expect(provider.generateStructured({
      system: "Return json.", user: "resume", schema: FactsSchema, jsonExample: { facts: [] }
    })).rejects.toMatchObject({ kind: "response" });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).model).toBe("deepseek-v4-flash");
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string).model).toBe("deepseek-v4-flash");
  });

  it("does not escalate when exhausted Flash attempts mix transport and validation failures", async () => {
    const fetch = fakeFetch(response(500), completion("not-json"));
    const provider = new DeepSeekStructuredModelProvider(config, { fetch: fetch as typeof globalThis.fetch, sleep: async () => undefined });

    await expect(provider.generateStructured({
      system: "Return json.", user: "resume", schema: FactsSchema, jsonExample: { facts: [] }
    })).rejects.toMatchObject({ kind: "validation" });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).model).toBe("deepseek-v4-flash");
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string).model).toBe("deepseek-v4-flash");
  });

  it("sanitizes a rejected retry sleep", async () => {
    const sleepSecret = "retry-sleep-secret";
    const fetch = fakeFetch(response(500));
    const sleep = vi.fn(async () => { throw new Error(sleepSecret); });
    const provider = new DeepSeekStructuredModelProvider(config, { fetch: fetch as typeof globalThis.fetch, sleep });

    const error = await capture(() => provider.generateStructured({
      system: "Return json.", user: "resume", schema: FactsSchema, jsonExample: { facts: [] }
    }));

    expect(error).toBeInstanceOf(DeepSeekProviderError);
    expect(error).toMatchObject({ kind: "response" });
    expect(errorText(error)).not.toContain(sleepSecret);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not escalate when retry sleep ends Flash validation retries early", async () => {
    const fetch = fakeFetch(completion("not-json"));
    const sleep = vi.fn(async () => { throw new Error("retry-sleep-secret"); });
    const provider = new DeepSeekStructuredModelProvider(config, { fetch: fetch as typeof globalThis.fetch, sleep });

    await expect(provider.generateStructured({
      system: "Return json.", user: "resume", schema: FactsSchema, jsonExample: { facts: [] }
    })).rejects.toMatchObject({ kind: "validation" });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).model).toBe("deepseek-v4-flash");
  });

  it.each([
    ["BigInt", BigInt(1)],
    ["cyclic object", (() => { const value: { self?: unknown } = {}; value.self = value; return value; })()]
  ])("rejects a non-serializable %s example locally", async (_caseName, jsonExample) => {
    const fetch = fakeFetch(completion(JSON.stringify({ facts: [] })));
    const sleep = vi.fn(async () => undefined);
    const provider = new DeepSeekStructuredModelProvider(config, { fetch: fetch as typeof globalThis.fetch, sleep });

    await expect(provider.generateStructured({
      system: "Return json.", user: "resume", schema: FactsSchema, jsonExample
    })).rejects.toMatchObject({ kind: "validation" });

    expect(fetch).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not expose reasoning content in a successful result", async () => {
    const fetch = fakeFetch(completion(JSON.stringify({ facts: [] }), "reasoning-secret-content"));
    const provider = new DeepSeekStructuredModelProvider(config, { fetch: fetch as typeof globalThis.fetch, sleep: async () => undefined });

    await expect(provider.generateStructured({
      system: "Return json.", user: "resume", schema: FactsSchema, jsonExample: { facts: [] }
    })).resolves.toEqual({ facts: [] });
  });

  it("observes raw adapter responses only when correlation metadata is present", async () => {
    const rawContent = JSON.stringify({ facts: [] });
    const observeRawResponse = vi.fn(async () => undefined);
    const provider = new DeepSeekStructuredModelProvider(config, {
      fetch: fakeFetch(completion(rawContent), completion(rawContent)) as typeof globalThis.fetch,
      sleep: async () => undefined,
      observeRawResponse
    });

    await provider.generateStructured({
      system: "Return json.",
      user: "sanitized observation",
      schema: FactsSchema,
      jsonExample: { facts: [] },
      metadata: { requestId: "proposal-1", purpose: "adapter_proposal" }
    });
    await provider.generateStructured({
      system: "Return json.",
      user: "ordinary request",
      schema: FactsSchema,
      jsonExample: { facts: [] }
    });

    expect(observeRawResponse).toHaveBeenCalledTimes(1);
    expect(observeRawResponse).toHaveBeenCalledWith({
      requestId: "proposal-1",
      purpose: "adapter_proposal",
      model: "deepseek-v4-flash",
      content: rawContent
    });
  });
});
