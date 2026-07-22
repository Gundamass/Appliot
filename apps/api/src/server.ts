import { createSqliteDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { createProfileRepository } from "./profile/profile-repository.js";
import { createApp, type AppDependencies } from "./app.js";

export function createProductionDependencies(): AppDependencies {
  const database = createSqliteDatabase("resume-assistant.sqlite");
  migrateDatabase(database);
  return {
    database,
    profileRepository: createProfileRepository(database),
    extractPdf: async () => { throw new Error("No local PDF extractor configured"); },
    extractFacts: async () => { throw new Error("No local fact extractor configured"); }
  };
}

const app = await createApp(createProductionDependencies());
await app.listen({ host: "127.0.0.1", port: 43120 });
