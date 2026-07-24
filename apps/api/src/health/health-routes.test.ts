import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterHealthResponseSchema } from "@resume/contracts";
import { createApp } from "../app.js";
import { migrateDatabase } from "../db/migrate.js";
import { createProfileRepository } from "../profile/profile-repository.js";
import { createAdapterHealthRegistry } from "./adapter-health.js";

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("adapter health route", () => {
  it("returns safe degraded state without probing paid DeepSeek", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const deepseekFetch = vi.fn();
    const workerFetch = vi.fn(async () => { throw new Error("offline at http://127.0.0.1 with test-token"); });
    const adapterHealth = createAdapterHealthRegistry({
      deepseek: { model: "deepseek-v4-flash" },
      embedding: {
        apiToken: "embedding-test-token", baseUrl: "http://127.0.0.1:18080",
        model: "Qwen/Qwen3-Embedding-8B", modelRevision: "revision", dimensions: 4096, timeoutMs: 60_000
      }
    }, { fetch: workerFetch });
    const app = await createApp({
      database,
      profileRepository: createProfileRepository(database),
      originalDocumentStore: { retain: vi.fn(), discardCreated: vi.fn() },
      extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }),
      extractFacts: async () => [],
      adapterHealth
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/health/adapters" });
    const payload = response.json();

    expect(response.statusCode).toBe(200);
    expect(AdapterHealthResponseSchema.parse(payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "deepseek", state: "configured", code: "not_checked" }),
      expect.objectContaining({ id: "embedding", state: "unavailable", code: "offline" })
    ]));
    expect(deepseekFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(payload)).not.toMatch(/test-token|127\.0\.0\.1|url|error|header|gpu|path/iu);
  });

  it("closes adapter health through app shutdown exactly once", async () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const closeHealth = vi.fn();
    const closeDependencies = vi.fn();
    const app = await createApp({
      database,
      profileRepository: createProfileRepository(database),
      originalDocumentStore: { retain: vi.fn(), discardCreated: vi.fn() },
      extractPdf: async () => ({ fingerprint: "a".repeat(64), pages: [] }),
      extractFacts: async () => [],
      adapterHealth: {
        getStatuses: vi.fn(async () => []), getState: () => "unconfigured",
        setDeepSeekState: vi.fn(), ensureFresh: vi.fn(), close: closeHealth
      },
      close: closeDependencies
    });

    await app.close();
    await app.close();

    expect(closeHealth).toHaveBeenCalledTimes(1);
    expect(closeDependencies).toHaveBeenCalledTimes(1);
  });
});
