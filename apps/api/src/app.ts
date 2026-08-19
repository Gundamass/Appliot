import Fastify from "fastify";
import multipart from "@fastify/multipart";
import type { ProfileFact } from "@resume/contracts";
import type { ExtractedDocument } from "@resume/profile-domain/src/pdf/types.js";
import type { StructuredModelProvider } from "@resume/model-provider";
import type { EmbeddingSearchPort } from "@resume/rag";
import type { SqliteDatabase } from "./db/client.js";
import { sendError } from "./http-response.js";
import { MAX_PDF_BYTES } from "./profile/import-service.js";
import { type ProfileRepository } from "./profile/profile-repository.js";
import { registerProfileRoutes } from "./profile/profile-routes.js";
import type { OriginalDocumentStore } from "./profile/original-document-store.js";
import type { AvatarStore } from "./profile/avatar-store.js";
import { createSelfEvaluationReviewRepository, type SelfEvaluationReviewRepository } from "./reviews/review-repository.js";
import { registerReviewRoutes } from "./reviews/review-routes.js";
import { registerRagRoutes } from "./rag/rag-routes.js";
import { createAdapterHealthRegistry, type AdapterHealthRegistry } from "./health/adapter-health.js";
import { registerHealthRoutes } from "./health/health-routes.js";
import { registerApplicationRoutes } from "./applications/routes.js";
import type { ApplicationService } from "./applications/application-service.js";
import type { TaskEventBus } from "./applications/task-events.js";
import { createApplicationTaskRepository } from "./applications/application-task-repository.js";
import { registerJobMatchRoutes } from "./job-matching/routes.js";
import type { createJobMatchService } from "./job-matching/job-match-service.js";
import { registerAdapterRoutes } from "./ats-adapters/routes.js";
import type { AdapterReviewService } from "./ats-adapters/adapter-review-service.js";

export type { AdapterHealthRegistry } from "./health/adapter-health.js";

export interface AppDependencies {
  database: SqliteDatabase;
  profileRepository: ProfileRepository;
  onProfileUpdated?: () => Promise<void> | void;
  originalDocumentStore: OriginalDocumentStore;
  avatarStore?: AvatarStore;
  reviewRepository?: SelfEvaluationReviewRepository;
  extractPdf(bytes: Uint8Array): Promise<ExtractedDocument>;
  extractFacts(document: ExtractedDocument): Promise<ProfileFact[]>;
  renderPdfPage?: (bytes: Uint8Array, page: number) => Promise<Uint8Array>;
  selfEvaluationModelProvider?: StructuredModelProvider;
  embeddingSearch?: EmbeddingSearchPort;
  adapterHealth: AdapterHealthRegistry;
  applicationService?: ApplicationService;
  adapterReviewService?: AdapterReviewService;
  jobMatchService?: ReturnType<typeof createJobMatchService>;
  taskEvents?: TaskEventBus;
  applicationSseHeartbeatMs?: number;
  close?(): void | Promise<void>;
}

type CreateAppDependencies = Omit<AppDependencies, "adapterHealth"> & Partial<Pick<AppDependencies, "adapterHealth">>;

export async function createApp(dependencies: CreateAppDependencies) {
  const adapterHealth = dependencies.adapterHealth ?? createAdapterHealthRegistry(
    dependencies.selfEvaluationModelProvider === undefined ? {} : { deepseek: {} }
  );
  const app = Fastify({ logger: false, bodyLimit: MAX_PDF_BYTES + 64 * 1024 });
  await app.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_PDF_BYTES },
    throwFileSizeLimit: true
  });
  app.addHook("onClose", async () => {
    adapterHealth.close();
    await dependencies.close?.();
  });
  app.setErrorHandler((error, _request, reply) => {
    const errorStatusCode = errorStatus(error);
    const statusCode = errorStatusCode !== undefined && errorStatusCode >= 400 && errorStatusCode < 500 ? 400 : 500;
    return sendError(reply, statusCode, statusCode === 400 ? "Invalid request" : "Internal server error");
  });
  registerProfileRoutes(app, dependencies);
  registerHealthRoutes(app, adapterHealth);
  registerRagRoutes(app, {
    profileRepository: dependencies.profileRepository,
    adapterHealth,
    ...(dependencies.embeddingSearch === undefined ? {} : { embeddingSearch: dependencies.embeddingSearch })
  });
  registerReviewRoutes(app, {
    profileRepository: dependencies.profileRepository,
    reviewRepository: dependencies.reviewRepository ?? createSelfEvaluationReviewRepository(dependencies.database),
    adapterHealth,
    ...(dependencies.selfEvaluationModelProvider === undefined
      ? {}
      : { selfEvaluationModelProvider: dependencies.selfEvaluationModelProvider })
  });
  if (dependencies.applicationService && dependencies.taskEvents) {
    registerApplicationRoutes(app, {
      applicationService: dependencies.applicationService,
      taskEvents: dependencies.taskEvents,
      tasks: createApplicationTaskRepository(dependencies.database),
      profileRepository: dependencies.profileRepository,
      ...(dependencies.applicationSseHeartbeatMs === undefined
        ? {}
        : { sseHeartbeatMs: dependencies.applicationSseHeartbeatMs })
    });
  }
  if (dependencies.adapterReviewService) {
    registerAdapterRoutes(app, dependencies.adapterReviewService);
  }
  if (dependencies.jobMatchService) {
    registerJobMatchRoutes(app, { service: dependencies.jobMatchService });
  }
  return app;
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}
