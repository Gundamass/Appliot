import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp, type AppDependencies } from "./app.js";
import { loadConfig, type ApiConfig } from "./config.js";
import { createProductionDependencies } from "./production-dependencies.js";

export { createProductionDependencies } from "./production-dependencies.js";

export async function startServer(dependencies: AppDependencies, config: ApiConfig) {
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp(dependencies);
    await app.listen({ host: config.host, port: config.port });
    return app;
  } catch (error) {
    if (app) {
      await app.close();
    } else {
      await dependencies.close?.();
    }
    throw error;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  const config = loadConfig(process.env);
  const app = await startServer(createProductionDependencies(config), config);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.close();
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
