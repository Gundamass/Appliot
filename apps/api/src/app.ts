import Fastify from "fastify";
import multipart from "@fastify/multipart";
import type { ProfileFact } from "@resume/contracts";
import type { ExtractedDocument } from "@resume/profile-domain/src/pdf/types.js";
import type { SqliteDatabase } from "./db/client.js";
import { sendError } from "./http-response.js";
import { MAX_PDF_BYTES } from "./profile/import-service.js";
import { type ProfileRepository } from "./profile/profile-repository.js";
import { registerProfileRoutes } from "./profile/profile-routes.js";
import { createSelfEvaluationReviewRepository, type SelfEvaluationReviewRepository } from "./reviews/review-repository.js";
import { registerReviewRoutes } from "./reviews/review-routes.js";

export interface AppDependencies {
  database: SqliteDatabase;
  profileRepository: ProfileRepository;
  reviewRepository?: SelfEvaluationReviewRepository;
  extractPdf(bytes: Uint8Array): Promise<ExtractedDocument>;
  extractFacts(document: ExtractedDocument): Promise<ProfileFact[]>;
  close?(): void | Promise<void>;
}

export async function createApp(dependencies: AppDependencies) {
  const app = Fastify({ logger: false, bodyLimit: MAX_PDF_BYTES + 64 * 1024 });
  await app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_PDF_BYTES },
    throwFileSizeLimit: true
  });
  if (dependencies.close) {
    app.addHook("onClose", async () => dependencies.close?.());
  }
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500 ? 400 : 500;
    return sendError(reply, statusCode, statusCode === 400 ? "Invalid request" : "Internal server error");
  });
  registerProfileRoutes(app, dependencies);
  registerReviewRoutes(app, {
    profileRepository: dependencies.profileRepository,
    reviewRepository: dependencies.reviewRepository ?? createSelfEvaluationReviewRepository(dependencies.database)
  });
  return app;
}
