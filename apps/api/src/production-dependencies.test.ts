import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { loadConfig } from "./config.js";

const fakes = vi.hoisted(() => ({
  databases: [] as Array<{ closeCalls: number }>,
  migrationFailure: undefined as Error | undefined
}));

vi.mock("./db/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db/client.js")>()),
  createSqliteDatabase: vi.fn((filename: string) => {
    const database = new Database(filename);
    const tracker = { closeCalls: 0 };
    const close = database.close.bind(database);
    database.close = () => {
      tracker.closeCalls += 1;
      return close();
    };
    fakes.databases.push(tracker);
    return database;
  })
}));
vi.mock("./db/migrate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db/migrate.js")>();
  return {
    ...actual,
    migrateDatabase(database: Parameters<typeof actual.migrateDatabase>[0]) {
      if (fakes.migrationFailure) throw fakes.migrationFailure;
      actual.migrateDatabase(database);
    }
  };
});

const { createProductionDependencies } = await import("./production-dependencies.js");

const QWEN_REVISION = "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af";
const OCR_REVISION = "aaa02f3811945a91062062994c5c4a3f4c0af2b0";

function fullConfig() {
  return loadConfig({
    DATABASE_FILE: ":memory:",
    DEEPSEEK_API_KEY: "deepseek-test-token",
    EMBEDDING_BASE_URL: "http://127.0.0.1:18080",
    EMBEDDING_API_TOKEN: "embedding-test-token",
    EMBEDDING_MODEL: "Qwen/Qwen3-Embedding-8B",
    EMBEDDING_MODEL_REVISION: QWEN_REVISION,
    EMBEDDING_DIMENSIONS: "4096",
    OCR_BASE_URL: "http://127.0.0.1:43121",
    OCR_API_TOKEN: "ocr-test-token",
    OCR_MODEL: "deepseek-ai/DeepSeek-OCR-2",
    OCR_MODEL_REVISION: OCR_REVISION
  });
}

describe("production dependency composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.databases.splice(0);
    fakes.migrationFailure = undefined;
  });

  it("composes configured adapters without making startup model requests", () => {
    const fetch = vi.fn();
    const dependencies = createProductionDependencies(fullConfig(), { fetch });

    expect(dependencies.extractPdf).toEqual(expect.any(Function));
    expect(dependencies.extractFacts).toEqual(expect.any(Function));
    expect(dependencies.selfEvaluationModelProvider).toBeDefined();
    expect(dependencies.embeddingSearch).toBeDefined();
    expect(dependencies.adapterHealth).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
    dependencies.close?.();
  });

  it("composes an unconfigured degraded app instead of throwing", () => {
    const dependencies = createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }));

    expect(dependencies.selfEvaluationModelProvider).toBeUndefined();
    expect(dependencies.embeddingSearch).toBeUndefined();
    expect(dependencies.close).toEqual(expect.any(Function));
    dependencies.close?.();
  });

  it("closes the owned database exactly once when migration fails", () => {
    const failure = new Error("migration failed");
    fakes.migrationFailure = failure;

    expect(() => createProductionDependencies(loadConfig({ DATABASE_FILE: ":memory:" }))).toThrow(failure);
    expect(fakes.databases[0]?.closeCalls).toBe(1);
  });
});
