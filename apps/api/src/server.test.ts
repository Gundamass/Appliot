import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDependencies } from "./app.js";
import type { ApiConfig } from "./config.js";

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
  startServer(dependencies: AppDependencies, config: ApiConfig): Promise<unknown>;
}

const server = await import("./server.js") as unknown as ServerModule;

describe("production server composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.createApp.mockResolvedValue(fakes.app);
    fakes.app.listen.mockResolvedValue("http://127.0.0.1:43120");
  });

  it("binds configured dependencies to the validated loopback address and port", async () => {
    const dependencies = { jobMatchService: { get: vi.fn() } } as unknown as AppDependencies;
    await server.startServer(dependencies, { databaseFile: ":memory:", host: "127.0.0.1", port: 43120 });

    expect(fakes.createApp).toHaveBeenCalledWith(dependencies);
    expect(fakes.app.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 43120 });
  });

  it("closes the app and owned resources when listening fails", async () => {
    const listenFailure = new Error("address already in use");
    fakes.app.listen.mockRejectedValueOnce(listenFailure);

    await expect(server.startServer({} as AppDependencies, { databaseFile: ":memory:", host: "127.0.0.1", port: 43120 })).rejects.toBe(listenFailure);
    expect(fakes.app.close).toHaveBeenCalledOnce();
  });

  it("closes owned resources when app construction fails", async () => {
    const startupFailure = new Error("app construction failed");
    const close = vi.fn();
    fakes.createApp.mockRejectedValueOnce(startupFailure);

    await expect(server.startServer({ close } as unknown as AppDependencies, { databaseFile: ":memory:", host: "127.0.0.1", port: 43120 })).rejects.toBe(startupFailure);
    expect(close).toHaveBeenCalledOnce();
    expect(fakes.app.close).not.toHaveBeenCalled();
  });
});
