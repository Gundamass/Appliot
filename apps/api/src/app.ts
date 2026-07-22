import Fastify from "fastify";
import multipart from "@fastify/multipart";
import type { ProfileFact } from "@resume/contracts";
import type { ExtractedDocument } from "@resume/profile-domain/src/pdf/types.js";
import { z } from "zod";
import type { SqliteDatabase } from "./db/client.js";
import { MAX_PDF_BYTES } from "./profile/import-service.js";
import { type ProfileRepository } from "./profile/profile-repository.js";
import { registerProfileRoutes } from "./profile/profile-routes.js";

export interface AppDependencies {
  database: SqliteDatabase;
  profileRepository: ProfileRepository;
  extractPdf(bytes: Uint8Array): Promise<ExtractedDocument>;
  extractFacts(document: ExtractedDocument): Promise<ProfileFact[]>;
}

export async function createApp(dependencies: AppDependencies) {
  const ErrorResponseSchema = z.object({ error: z.string().min(1) });
  const app = Fastify({ logger: false, bodyLimit: MAX_PDF_BYTES + 64 * 1024 });
  await app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_PDF_BYTES },
    throwFileSizeLimit: true
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 ? 400 : 500;
    reply.code(statusCode).send(ErrorResponseSchema.parse({
      error: statusCode === 400 ? "Invalid request" : "Internal server error"
    }));
  });
  registerProfileRoutes(app, dependencies);
  return app;
}
