import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDependencies } from "./app.js";

const fakes = vi.hoisted(() => {
  const database = { close: vi.fn() };
  const app = {
    listen: vi.fn(async () => "http://127.0.0.1:43120"),
    close: vi.fn(async () => undefined)
  };
  return {
    database,
    app,
    createApp: vi.fn(async () => app),
    migrateDatabase: vi.fn(),
    createProfileRepository: vi.fn(() => ({ repository: true }))
  };
});

vi.mock("./db/client.js", () => ({ createSqliteDatabase: vi.fn(() => fakes.database) }));
vi.mock("./db/migrate.js", () => ({ migrateDatabase: fakes.migrateDatabase }));
vi.mock("./profile/profile-repository.js", () => ({ createProfileRepository: fakes.createProfileRepository }));
vi.mock("./app.js", () => ({ createApp: fakes.createApp }));

interface ServerModule {
  createProductionDependencies(
    extraction?: Pick<AppDependencies, "extractPdf" | "extractFacts">,
    databaseFilename?: string
  ): AppDependencies;
  startServer(dependencies: AppDependencies): Promise<unknown>;
}

const server = await import("./server.js") as unknown as ServerModule;

describe("production server composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.createApp.mockResolvedValue(fakes.app);
    fakes.app.listen.mockResolvedValue("http://127.0.0.1:43120");
  });

  it("fails clearly before listening when extraction is not configured", () => {
    expect(() => server.createProductionDependencies()).toThrow(
      "Local PDF and fact extraction dependencies must be configured before starting the API"
    );
    expect(fakes.createApp).not.toHaveBeenCalled();
    expect(fakes.app.listen).not.toHaveBeenCalled();
  });

  it("composes configured extraction with an owned SQLite close callback", async () => {
    const extraction = {
      extractPdf: vi.fn(async () => ({ fingerprint: "a".repeat(64), pages: [] })),
      extractFacts: vi.fn(async () => [])
    };

    const dependencies = server.createProductionDependencies(extraction, "profile.sqlite");
    expect(dependencies.extractPdf).toBe(extraction.extractPdf);
    expect(dependencies.extractFacts).toBe(extraction.extractFacts);

    await dependencies.close?.();
    expect(fakes.database.close).toHaveBeenCalledOnce();
  });

  it("closes the owned database when production composition fails", () => {
    const migrationFailure = new Error("migration failed");
    fakes.migrateDatabase.mockImplementationOnce(() => { throw migrationFailure; });
    const extraction = {
      extractPdf: vi.fn(async () => ({ fingerprint: "a".repeat(64), pages: [] })),
      extractFacts: vi.fn(async () => [])
    };

    expect(() => server.createProductionDependencies(extraction)).toThrow(migrationFailure);
    expect(fakes.database.close).toHaveBeenCalledOnce();
  });

  it("binds configured dependencies to the fixed loopback address", async () => {
    const dependencies = {} as AppDependencies;
    await server.startServer(dependencies);

    expect(fakes.createApp).toHaveBeenCalledWith(dependencies);
    expect(fakes.app.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 43120 });
  });

  it("closes the app and owned resources when listening fails", async () => {
    const listenFailure = new Error("address already in use");
    fakes.app.listen.mockRejectedValueOnce(listenFailure);

    await expect(server.startServer({} as AppDependencies)).rejects.toBe(listenFailure);
    expect(fakes.app.close).toHaveBeenCalledOnce();
  });

  it("closes owned resources when app construction fails", async () => {
    const startupFailure = new Error("app construction failed");
    const close = vi.fn();
    fakes.createApp.mockRejectedValueOnce(startupFailure);

    await expect(server.startServer({ close } as unknown as AppDependencies)).rejects.toBe(startupFailure);
    expect(close).toHaveBeenCalledOnce();
    expect(fakes.app.close).not.toHaveBeenCalled();
  });
});
