import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./provider.js";
import {
  RemoteEmbeddingError,
  RemoteEmbeddingProvider
} from "./remote-embedding-provider.js";
import {
  ScheduledEmbeddingProvider,
  type EmbeddingSchedule,
  type EmbeddingScheduleEvent
} from "./scheduled-embedding-provider.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("ScheduledEmbeddingProvider", () => {
  it("splits 83 documents into ordered batches of 32, 32, and 19", async () => {
    const embedDocuments = vi.fn(async (texts: string[]) => texts.map((text) => [Number(text)]));
    const provider = new ScheduledEmbeddingProvider({
      embedDocuments,
      embedQuery: vi.fn()
    }, { maxBatchSize: 32, maxConcurrency: 1 });
    const texts = Array.from({ length: 83 }, (_, index) => String(index));

    await expect(provider.embedDocuments(texts)).resolves.toEqual(
      Array.from({ length: 83 }, (_, index) => [index])
    );
    expect(embedDocuments.mock.calls.map(([batch]) => batch.length)).toEqual([32, 32, 19]);
  });

  it("rejects invalid local input and schedules without calling the delegate", async () => {
    const delegate: EmbeddingProvider = {
      embedDocuments: vi.fn(),
      embedQuery: vi.fn()
    };
    const provider = new ScheduledEmbeddingProvider(delegate, {
      maxBatchSize: 32,
      maxConcurrency: 1
    });

    await expect(provider.embedDocuments([])).rejects.toThrow();
    expect(delegate.embedDocuments).not.toHaveBeenCalled();
    expect(() => new ScheduledEmbeddingProvider(delegate, {
      maxBatchSize: 0,
      maxConcurrency: 1
    })).toThrow();
    expect(() => new ScheduledEmbeddingProvider(delegate, {
      maxBatchSize: 32,
      maxConcurrency: 2
    } as unknown as EmbeddingSchedule)).toThrow();
  });

  it("shares one FIFO queue between document batches and queries", async () => {
    const documentGates = [deferred<number[][]>(), deferred<number[][]>()];
    const queryGates = [deferred<number[]>(), deferred<number[]>()];
    const starts: string[] = [];
    let active = 0;
    let maxActive = 0;
    const begin = (name: string) => {
      starts.push(name);
      active += 1;
      maxActive = Math.max(maxActive, active);
    };
    const finish = () => {
      active -= 1;
    };
    let documentCall = 0;
    let queryCall = 0;
    const provider = new ScheduledEmbeddingProvider({
      async embedDocuments(texts) {
        const index = documentCall++;
        begin(`documents:${texts[0]}`);
        try {
          return await documentGates[index]!.promise;
        } finally {
          finish();
        }
      },
      async embedQuery(text) {
        const index = queryCall++;
        begin(`query:${text}`);
        try {
          return await queryGates[index]!.promise;
        } finally {
          finish();
        }
      }
    }, { maxBatchSize: 32, maxConcurrency: 1 });

    const firstDocuments = provider.embedDocuments(["first"]);
    const firstQuery = provider.embedQuery("second");
    const secondDocuments = provider.embedDocuments(["third"]);
    const secondQuery = provider.embedQuery("fourth");

    await vi.waitFor(() => expect(starts).toEqual(["documents:first"]));
    documentGates[0]!.resolve([[1]]);
    await vi.waitFor(() => expect(starts).toEqual(["documents:first", "query:second"]));
    queryGates[0]!.resolve([2]);
    await vi.waitFor(() => expect(starts).toEqual(["documents:first", "query:second", "documents:third"]));
    documentGates[1]!.resolve([[3]]);
    await vi.waitFor(() => expect(starts).toEqual([
      "documents:first",
      "query:second",
      "documents:third",
      "query:fourth"
    ]));
    queryGates[1]!.resolve([4]);

    await expect(Promise.all([firstDocuments, firstQuery, secondDocuments, secondQuery])).resolves.toEqual([
      [[1]], [2], [[3]], [4]
    ]);
    expect(maxActive).toBe(1);
  });

  it("stops a document operation after a failed batch and emits sanitized events", async () => {
    const rawMessage = "provider failed while embedding confidential-document api-token-value";
    const events: EmbeddingScheduleEvent[] = [];
    const embedDocuments = vi.fn(async (texts: string[]) => {
      if (embedDocuments.mock.calls.length === 2) {
        const error = new RemoteEmbeddingError("rate_limit");
        error.message = rawMessage;
        throw error;
      }
      return texts.map((_, index) => [index]);
    });
    const provider = new ScheduledEmbeddingProvider({
      embedDocuments,
      embedQuery: vi.fn(async () => [1])
    }, {
      maxBatchSize: 32,
      maxConcurrency: 1,
      onEvent: (event) => events.push(event)
    });

    await expect(provider.embedDocuments(Array.from(
      { length: 65 },
      (_, index) => `confidential-document-${index}`
    ))).rejects.toBeInstanceOf(RemoteEmbeddingError);
    expect(embedDocuments.mock.calls.map(([batch]) => batch.length)).toEqual([32, 32]);
    expect(events).toEqual([
      expect.objectContaining({ kind: "documents", batchSize: 32, result: "succeeded" }),
      expect.objectContaining({
        kind: "documents",
        batchSize: 32,
        result: "failed",
        errorKind: "rate_limit"
      })
    ]);
    expect(events.every((event) => event.queueWaitMs >= 0)).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("confidential-document");
    expect(serialized).not.toContain("api-token-value");
    expect(serialized).not.toContain(rawMessage);
  });

  it("does not multiply the remote provider retry budget", async () => {
    const fetch = vi.fn(async () => new Response(undefined, { status: 429 }));
    const sleep = vi.fn(async () => undefined);
    const events: EmbeddingScheduleEvent[] = [];
    const remote = new RemoteEmbeddingProvider({
      apiToken: "test-token",
      baseUrl: "http://127.0.0.1:18080",
      model: "Qwen/Qwen3-Embedding-8B",
      modelRevision: "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af",
      dimensions: 4
    }, {
      fetch: fetch as typeof globalThis.fetch,
      sleep
    });
    const provider = new ScheduledEmbeddingProvider(remote, {
      maxBatchSize: 32,
      maxConcurrency: 1,
      onEvent: (event) => events.push(event)
    });

    await expect(provider.embedDocuments(["document"])).rejects.toMatchObject({ kind: "rate_limit" });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      expect.objectContaining({ kind: "documents", result: "failed", errorKind: "rate_limit" })
    ]);
  });
});
