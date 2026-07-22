import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSqliteDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { createProfileRepository } from "./profile/profile-repository.js";
import { createApp, type AppDependencies } from "./app.js";

type ExtractionDependencies = Pick<AppDependencies, "extractPdf" | "extractFacts">;

const missingExtractionMessage =
  "Local PDF and fact extraction dependencies must be configured before starting the API";

export function createProductionDependencies(
  extraction?: ExtractionDependencies,
  databaseFilename = "resume-assistant.sqlite"
): AppDependencies {
  if (!extraction) {
    throw new Error(missingExtractionMessage);
  }

  const database = createSqliteDatabase(databaseFilename);
  try {
    migrateDatabase(database);
    return {
      database,
      profileRepository: createProfileRepository(database),
      ...extraction,
      close: () => {
        database.close();
      }
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function startServer(dependencies: AppDependencies) {
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp(dependencies);
    await app.listen({ host: "127.0.0.1", port: 43120 });
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
  await startServer(createProductionDependencies());
}
