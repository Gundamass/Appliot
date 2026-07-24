import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { StructuredModelProvider } from "@resume/model-provider";
import { createAdapterHealthRegistry, ObservedStructuredModelProvider } from "./adapter-health.js";

const embedding = {
  apiToken: "embedding-test-token",
  baseUrl: "http://127.0.0.1:18080",
  model: "Qwen/Qwen3-Embedding-8B",
  modelRevision: "embedding-revision",
  dimensions: 4096,
  timeoutMs: 60_000
};
const ocr = {
  apiToken: "ocr-test-token",
  baseUrl: "http://127.0.0.1:43121",
  model: "deepseek-ai/DeepSeek-OCR-2",
  modelRevision: "ocr-revision",
  timeoutMs: 180_000
};

describe("adapter health registry", () => {
  it("probes only worker readyz endpoints concurrently with bearer auth", async () => {
    const releases: Array<() => void> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      const url = String(input);
      return Response.json(url.includes("18080")
        ? { status: "ready", model: embedding.model, modelRevision: embedding.modelRevision, dimensions: 4096 }
        : { status: "ready", model: ocr.model, modelRevision: ocr.modelRevision });
    });
    const registry = createAdapterHealthRegistry({
      deepseek: { model: "deepseek-v4-flash" }, embedding, ocr
    }, { fetch, probeTimeoutMs: 1_000 });

    const statusesPromise = registry.getStatuses();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      "http://127.0.0.1:18080/readyz",
      "http://127.0.0.1:43121/readyz"
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({ method: "GET", headers: { Authorization: expect.stringMatching(/^Bearer /u) } });
    }
    releases.splice(0).forEach((release) => release());

    await expect(statusesPromise).resolves.toEqual([
      { id: "deepseek", state: "configured", model: "deepseek-v4-flash", code: "not_checked" },
      { id: "embedding", state: "ready", model: embedding.model, modelRevision: embedding.modelRevision },
      { id: "ocr", state: "ready", model: ocr.model, modelRevision: ocr.modelRevision }
    ]);
  });

  it("coalesces concurrent probes and caches the result for five seconds", async () => {
    let now = 1_000;
    const fetch = vi.fn(async () => Response.json({
      status: "ready", model: embedding.model, modelRevision: embedding.modelRevision, dimensions: 4096
    }));
    const registry = createAdapterHealthRegistry({ embedding }, { fetch, now: () => now });

    await Promise.all([registry.getStatuses(), registry.getStatuses()]);
    await registry.getStatuses();
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 5_001;
    await registry.getStatuses();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["wrong model", { status: "ready", model: "wrong", modelRevision: embedding.modelRevision, dimensions: 4096 }],
    ["wrong revision", { status: "ready", model: embedding.model, modelRevision: "wrong", dimensions: 4096 }],
    ["missing dimensions", { status: "ready", model: embedding.model, modelRevision: embedding.modelRevision }],
    ["wrong dimensions", { status: "ready", model: embedding.model, modelRevision: embedding.modelRevision, dimensions: 1024 }]
  ])("marks embedding invalid for a %s readiness contract", async (_name, payload) => {
    const registry = createAdapterHealthRegistry({ embedding }, { fetch: vi.fn(async () => Response.json(payload)) });
    await expect(registry.getStatuses()).resolves.toContainEqual({
      id: "embedding", state: "invalid", model: embedding.model,
      modelRevision: embedding.modelRevision, code: "contract_mismatch"
    });
  });

  it("maps unready, offline, and unconfigured workers to stable safe codes", async () => {
    const unready = createAdapterHealthRegistry({ ocr }, {
      fetch: vi.fn(async () => Response.json({ status: "not_ready", detail: "GPU process path and token" }, { status: 503 }))
    });
    const offline = createAdapterHealthRegistry({ embedding }, {
      fetch: vi.fn(async () => { throw new Error("connect ECONNREFUSED http://token@127.0.0.1"); })
    });

    await expect(unready.getStatuses()).resolves.toContainEqual({
      id: "ocr", state: "unavailable", model: ocr.model, modelRevision: ocr.modelRevision, code: "not_ready"
    });
    await expect(offline.getStatuses()).resolves.toContainEqual({
      id: "embedding", state: "unavailable", model: embedding.model,
      modelRevision: embedding.modelRevision, code: "offline"
    });
    expect((await offline.getStatuses()).find((status) => status.id === "ocr")).toEqual({
      id: "ocr", state: "unconfigured", code: "not_configured"
    });
  });

  it("bounds worker probes with the short timeout", async () => {
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const registry = createAdapterHealthRegistry({ embedding }, { fetch, probeTimeoutMs: 5 });

    await expect(registry.getStatuses()).resolves.toContainEqual({
      id: "embedding", state: "unavailable", model: embedding.model,
      modelRevision: embedding.modelRevision, code: "offline"
    });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("coalesces and caches readiness independently for each worker", async () => {
    let now = 1_000;
    const fetch = vi.fn(async (input: string | URL | Request) => Response.json(String(input).includes("18080")
      ? { status: "ready", model: embedding.model, modelRevision: embedding.modelRevision, dimensions: embedding.dimensions }
      : { status: "ready", model: ocr.model, modelRevision: ocr.modelRevision }));
    const registry = createAdapterHealthRegistry({ embedding, ocr }, { fetch, now: () => now });

    await Promise.all([registry.ensureFresh("embedding"), registry.ensureFresh("embedding")]);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(["http://127.0.0.1:18080/readyz"]);

    now += 4_000;
    await registry.ensureFresh("ocr");
    now += 2_000;
    await registry.getStatuses();

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "http://127.0.0.1:18080/readyz",
      "http://127.0.0.1:43121/readyz",
      "http://127.0.0.1:18080/readyz"
    ]);
  });

  it("aborts active probes on close and ignores late results", async () => {
    let release: ((response: Response) => void) | undefined;
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    const registry = createAdapterHealthRegistry({ embedding }, { fetch, probeTimeoutMs: 10_000 });

    const pending = registry.ensureFresh("embedding");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    registry.close();
    expect(signal?.aborted).toBe(true);
    release?.(Response.json({
      status: "ready", model: embedding.model, modelRevision: embedding.modelRevision, dimensions: embedding.dimensions
    }));
    await pending;

    expect(registry.getState("embedding")).not.toBe("ready");
    await registry.ensureFresh("embedding");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("ObservedStructuredModelProvider", () => {
  it("marks DeepSeek ready only after a successful real generation", async () => {
    const registry = createAdapterHealthRegistry({ deepseek: { model: "deepseek-v4-flash" } });
    const delegate: StructuredModelProvider = {
      async generateStructured<T>() { return { value: "ok" } as T; }
    };
    const provider = new ObservedStructuredModelProvider(delegate, registry);

    expect(registry.getState("deepseek")).toBe("configured");
    await expect(provider.generateStructured({
      system: "system", user: "user", schema: z.object({ value: z.string() }), jsonExample: { value: "" }
    })).resolves.toEqual({ value: "ok" });
    expect(registry.getState("deepseek")).toBe("ready");
  });

  it("marks DeepSeek unavailable before rethrowing a real failure", async () => {
    const registry = createAdapterHealthRegistry({ deepseek: { model: "deepseek-v4-flash" } });
    const failure = new Error("paid provider token leaked here");
    const delegate: StructuredModelProvider = {
      async generateStructured<T>(): Promise<T> { throw failure; }
    };
    const provider = new ObservedStructuredModelProvider(delegate, registry);

    try {
      await provider.generateStructured({
        system: "system", user: "user", schema: z.object({ value: z.string() }), jsonExample: { value: "" }
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(registry.getState("deepseek")).toBe("unavailable");
      expect(error).toBe(failure);
    }
  });
});
