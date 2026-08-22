import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionPolicy } from "@resume/action-policy";
import { djiJobAdapter, jobExpectationSnapshot, mokaJobAdapter } from "@resume/job-matching";
import {
  DeepSeekStructuredModelProvider,
  EMBEDDING_INSTRUCTION_VERSION,
  RemoteEmbeddingProvider,
  ScheduledEmbeddingProvider
} from "@resume/model-provider";
import { RemoteOcrEngine } from "@resume/profile-domain/src/pdf/remote-ocr-engine.js";
import {
  createRagService,
  validateEditedSelfEvaluation
} from "@resume/rag";
import { createApplicationService } from "./applications/application-service.js";
import { createApplicationTaskRepository } from "./applications/application-task-repository.js";
import { createCheckpointRepository } from "./applications/checkpoint-repository.js";
import {
  createFieldSemanticResolver
} from "./applications/field-semantic-resolver.js";
import { FieldOntologyIndex } from "./applications/field-ontology-index.js";
import {
  createProductionFieldResolver,
  fieldPathForApplicationAnswer
} from "./applications/production-field-resolver.js";
import { createTaskEventBus } from "./applications/task-events.js";
import { BrowserWorkerClient } from "./browser/worker-client.js";
import { BrowserOwnershipLease } from "./browser/browser-ownership-lease.js";
import { createFactEmbeddingSearch } from "./rag/fact-embedding-search.js";
import { createRestrictedToolRegistry, type RestrictedToolRegistry } from "./agent/tool-registry.js";
import { type AdapterHealthRegistry, type AppDependencies } from "./app.js";
import type { ApiConfig } from "./config.js";
import { createSqliteDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { createLocalOriginalDocumentStore } from "./profile/original-document-store.js";
import { createLocalAvatarStore } from "./profile/avatar-store.js";
import { createDocumentRepository } from "./profile/document-repository.js";
import { createProductionExtraction } from "./profile/production-extraction.js";
import { createProfileRepository } from "./profile/profile-repository.js";
import { createAdapterHealthRegistry, ObservedStructuredModelProvider } from "./health/adapter-health.js";
import { BoundedEmbeddingTraceBuffer } from "./observability/embedding-trace.js";
import { createExtractionCoordinator } from "./job-matching/extraction-coordinator.js";
import { createJobMatchRepository, type JobMatchRepository } from "./job-matching/job-match-repository.js";
import { createJobMatchService } from "./job-matching/job-match-service.js";
import { createMatchCoordinator } from "./job-matching/match-coordinator.js";
import {
  createLightRagEvidenceRetrievalClient,
  LightRagRetrievalError,
  type EvidenceRetrievalPort,
  type EvidenceRetrievalRequest
} from "./job-matching/lightrag-retrieval-client.js";
import { BoundedJobMatchTraceBuffer } from "./observability/job-match-trace.js";

type ProductionBrowserClient = Pick<BrowserWorkerClient, "open" | "observe" | "execute" | "stop">
  & Partial<Pick<BrowserWorkerClient,
    "invalidateExecution" | "releaseTask" | "onActivity" | "observeJob" | "applyJobFilters" | "advanceJobPage">>;

export interface ProductionAdapterDependencies {
  fetch?: typeof globalThis.fetch;
  evidenceRetrievalFallback?: EvidenceRetrievalPort;
  browserClient?: ProductionBrowserClient;
  browserClientFactory?: () => Promise<ProductionBrowserClient>;
}

export interface ProductionDependencies extends AppDependencies {
  embeddingTrace: BoundedEmbeddingTraceBuffer;
  jobMatchRepository: JobMatchRepository;
  jobMatchService: ReturnType<typeof createJobMatchService>;
  jobMatchTrace: BoundedJobMatchTraceBuffer;
  browserOwnershipLease: BrowserOwnershipLease;
  evidenceRetrieval: EvidenceRetrievalPort;
  agentToolRegistry: RestrictedToolRegistry;
}

export function createProductionDependencies(
  config: ApiConfig,
  adapters: ProductionAdapterDependencies = {}
): ProductionDependencies {
  const database = createSqliteDatabase(config.databaseFile);
  let closed = false;
  let shuttingDown = false;
  let closingDependencies: Promise<void> | undefined;
  const closeDatabase = () => {
    if (closed) return;
    closed = true;
    database.close();
  };
  try {
    migrateDatabase(database);
    const profileRepository = createProfileRepository(database);
    const documentRepository = createDocumentRepository(database);
    const originalsDirectory = resolve(dirname(resolve(config.databaseFile)), "originals");
    const approvalKey = randomBytes(32);
    const actionPolicy = new ActionPolicy(approvalKey);
    type BrowserClient = ProductionBrowserClient;
    const bundledWorkerEntry = new URL(import.meta.url).pathname.endsWith("/dist/server.js")
      ? fileURLToPath(new URL("./browser-worker.js", import.meta.url))
      : undefined;
    const browserClientFactory: () => Promise<BrowserClient> = adapters.browserClientFactory
      ?? (adapters.browserClient === undefined
        ? () => BrowserWorkerClient.start({
            profileDir: resolve(dirname(resolve(config.databaseFile)), "browser-profile"),
            approvalKey,
            uploadDirectory: originalsDirectory,
            ...(bundledWorkerEntry === undefined ? {} : { workerEntry: bundledWorkerEntry })
          })
        : async () => adapters.browserClient!);
    let browserClient: Promise<BrowserClient> | undefined;
    let resolvedBrowserClient: BrowserClient | undefined;
    let recyclingBrowserClient: Promise<BrowserClient> | undefined;
    const tasksWithOpenAttempt = new Set<string>();
    const activityListeners = new Map<Parameters<BrowserWorkerClient["onActivity"]>[0], () => void>();
    const startBrowserClient = async (): Promise<BrowserClient> => {
      if (shuttingDown) throw new Error("production_dependencies_closed");
      const pending = Promise.resolve().then(browserClientFactory);
      browserClient = pending;
      try {
        const client = await pending;
        if (browserClient === pending) {
          resolvedBrowserClient = client;
          for (const [listener, unsubscribe] of activityListeners) {
            if (unsubscribe === noop && client.onActivity) {
              activityListeners.set(listener, client.onActivity(listener));
            }
          }
        }
        return client;
      } catch (error) {
        if (browserClient === pending) browserClient = undefined;
        throw error;
      }
    };
    const getBrowserClient = (): Promise<BrowserClient> => {
      if (shuttingDown) return Promise.reject(new Error("production_dependencies_closed"));
      if (recyclingBrowserClient) return recyclingBrowserClient;
      return browserClient ?? startBrowserClient();
    };
    const recycleBrowserClient = async (failedClient: BrowserClient): Promise<BrowserClient> => {
      if (shuttingDown) throw new Error("production_dependencies_closed");
      if (resolvedBrowserClient && resolvedBrowserClient !== failedClient) return resolvedBrowserClient;
      if (recyclingBrowserClient) return recyclingBrowserClient;
      const recycling = (async () => {
        for (const [listener, unsubscribe] of activityListeners) {
          unsubscribe();
          activityListeners.set(listener, noop);
        }
        if (resolvedBrowserClient === failedClient) resolvedBrowserClient = undefined;
        browserClient = undefined;
        await failedClient.stop();
        if (shuttingDown) throw new Error("production_dependencies_closed");
        return startBrowserClient();
      })();
      recyclingBrowserClient = recycling;
      try {
        return await recycling;
      } finally {
        if (recyclingBrowserClient === recycling) recyclingBrowserClient = undefined;
      }
    };
    const adapterHealth: AdapterHealthRegistry = createAdapterHealthRegistry({
      ...(config.deepseek === undefined ? {} : { deepseek: { model: config.deepseek.defaultModel } }),
      ...(config.embedding === undefined ? {} : { embedding: config.embedding }),
      ...(config.ocr === undefined ? {} : { ocr: config.ocr })
    }, adapters);
    const baseStructuredProvider = config.deepseek === undefined
      ? undefined
      : new DeepSeekStructuredModelProvider(config.deepseek, adapters);
    const structuredProvider = baseStructuredProvider === undefined
      ? undefined
      : new ObservedStructuredModelProvider(baseStructuredProvider, adapterHealth);
    const ocrEngine = config.ocr === undefined
      ? undefined
      : new RemoteOcrEngine(config.ocr, adapters);
    const embeddingTrace = new BoundedEmbeddingTraceBuffer();
    const remoteEmbeddingProvider = config.embedding === undefined
      ? undefined
      : new RemoteEmbeddingProvider(config.embedding, adapters);
    const embeddingProvider = remoteEmbeddingProvider === undefined
      ? undefined
      : new ScheduledEmbeddingProvider(remoteEmbeddingProvider, {
          maxBatchSize: 32,
          maxConcurrency: 1,
          onEvent(event) {
            embeddingTrace.record({
              operation: event.kind,
              batchSize: event.batchSize,
              queueWaitMs: event.queueWaitMs,
              ...(event.errorKind === undefined ? {} : { providerErrorKind: event.errorKind }),
              deepSeekUsed: false,
              result: event.result
            });
          }
        });
    const embeddingIdentity = config.embedding === undefined
      ? undefined
      : {
          model: config.embedding.model,
          modelRevision: config.embedding.modelRevision,
          instructionVersion: EMBEDDING_INSTRUCTION_VERSION
        };
    const ontologyIndex = embeddingProvider === undefined
      ? undefined
      : new FieldOntologyIndex(embeddingProvider, embeddingTrace);
    const fieldSemanticResolver = createFieldSemanticResolver({
      ...(embeddingProvider === undefined || ontologyIndex === undefined || embeddingIdentity === undefined
        ? {}
        : { embeddingProvider, ontologyIndex, embeddingIdentity }),
      ...(structuredProvider === undefined ? {} : { structuredProvider }),
      traceSink: embeddingTrace
    });
    const embeddingSearch = embeddingProvider === undefined
      ? undefined
      : createFactEmbeddingSearch(database, profileRepository, embeddingProvider, {
        model: config.embedding!.model,
        modelRevision: config.embedding!.modelRevision,
        dimensions: config.embedding!.dimensions,
        normalization: "l2",
        instructionVersion: EMBEDDING_INSTRUCTION_VERSION
      }, embeddingTrace);
    const extraction = createProductionExtraction({
      ...(structuredProvider === undefined ? {} : { structuredProvider }),
      ...(ocrEngine === undefined ? {} : { ocrEngine })
    });
    const ragService = createRagService({
      repository: profileRepository,
      ...(embeddingSearch === undefined ? {} : { embeddingSearch })
    });
    const evidenceRetrieval: EvidenceRetrievalPort = config.lightRag === undefined
      ? unavailableEvidenceRetrieval
      : createLightRagEvidenceRetrievalClient(config.lightRag, {
          ...(adapters.fetch === undefined ? {} : { fetch: adapters.fetch }),
          ...(adapters.evidenceRetrievalFallback === undefined ? {} : { fallback: adapters.evidenceRetrievalFallback })
        });
    const agentToolRegistry = createRestrictedToolRegistry({
      retrieve_job_evidence: {
        allowedCallers: ["graph"],
        handler: (input) => evidenceRetrieval.retrieve(input as EvidenceRetrievalRequest)
      }
    });
    const resolveApplicationField = createProductionFieldResolver({
      semanticResolver: fieldSemanticResolver,
      ragService,
      profileRepository
    });
    const taskEvents = createTaskEventBus(database);
    const taskRepository = createApplicationTaskRepository(database);
    const browserOwnershipLease = new BrowserOwnershipLease();
    const openBrowser = async (taskId: string, url: string) => {
      const client = await getBrowserClient();
      const firstOpenAttempt = !tasksWithOpenAttempt.has(taskId);
      tasksWithOpenAttempt.add(taskId);
      try {
        return await client.open(taskId, url);
      } catch (error) {
        if (!firstOpenAttempt) throw error;
        return (await recycleBrowserClient(client)).open(taskId, url);
      }
    };
    const releaseBrowserTask = async (taskId: string): Promise<void> => {
      const client = await getBrowserClient();
      try {
        await client.releaseTask?.(taskId);
      } catch {
        await recycleBrowserClient(client);
      }
      tasksWithOpenAttempt.delete(taskId);
    };
    const applicationService = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      taskRepository,
      profileRevision: () => profileRepository.currentRevision(),
      taskEvents,
      browserOwnershipLease,
      browser: {
        async open(taskId, url) {
          return openBrowser(taskId, url);
        },
        async observe(taskId) {
          return (await (await getBrowserClient()).observe(taskId)).snapshot;
        },
        async execute(command, executionEpoch) {
          return (await getBrowserClient()).execute(command, executionEpoch);
        },
        async invalidateExecution(taskId, executionEpoch) {
          await (await getBrowserClient()).invalidateExecution?.(taskId, executionEpoch);
        },
        async releaseTask(taskId) {
          await releaseBrowserTask(taskId);
        },
        onActivity(listener) {
          activityListeners.set(listener, resolvedBrowserClient?.onActivity?.(listener) ?? noop);
          return () => {
            activityListeners.get(listener)?.();
            activityListeners.delete(listener);
          };
        }
      },
      resolveField: resolveApplicationField,
      listProfileFacts() {
        return profileRepository.listActive();
      },
      approve(input, snapshot) {
        return actionPolicy.approve(input, snapshot).token;
      },
      async applyAnswers(taskId, answers, fields, questions = []) {
        profileRepository.transaction(() => {
          for (const [fieldId, value] of Object.entries(answers)) {
            const field = fields.find((candidate) => candidate.id === fieldId);
            if (!field) throw new Error("answer_field_not_found");
            const fieldPath = fieldPathForApplicationAnswer(field, questions);
            profileRepository.putTaskAnswer(taskId, fieldPath, value as never, [{
              documentId: "user",
              page: 1,
              text: JSON.stringify(value),
              extraction: "user"
            }]);
          }
        });
      },
      validateContentReview(review, editedValue) {
        return validateEditedSelfEvaluation(review.original, editedValue, review.evidence);
      },
      resolveFileId(_taskId, field) {
        if (/avatar|photo|头像|照片|证件照/iu.test(`${field.semanticHint ?? ""} ${field.label}`)) {
          const avatar = profileRepository.resolveForTask(_taskId, "basics.avatar")?.value;
          return typeof avatar === "string" && /^avatar-[0-9a-f-]+\.(?:jpg|png|webp)$/u.test(avatar) ? avatar : undefined;
        }
        const document = documentRepository.findLatestCompleted();
        return /resume|cv|简历/iu.test(`${field.semanticHint ?? ""} ${field.label}`) && document !== undefined
          ? `${document.fingerprint}.pdf`
          : undefined;
      }
    });
    const jobMatchRepository = createJobMatchRepository(database);
    const jobMatchTrace = new BoundedJobMatchTraceBuffer();
    const jobAdapters = [mokaJobAdapter, djiJobAdapter] as const;
    const jobBrowser = {
      open: openBrowser,
      async observeJob(ownerId: string) {
        const client = await getBrowserClient();
        if (client.observeJob === undefined) throw new Error("job_browser_observe_unavailable");
        return client.observeJob(ownerId);
      },
      async applyJobFilters(ownerId: string, plan: Parameters<BrowserWorkerClient["applyJobFilters"]>[1], executionEpoch: number) {
        const client = await getBrowserClient();
        if (client.applyJobFilters === undefined) throw new Error("job_browser_filter_unavailable");
        return client.applyJobFilters(ownerId, plan, executionEpoch);
      },
      async advanceJobPage(ownerId: string, cursor: string | undefined, executionEpoch: number) {
        const client = await getBrowserClient();
        if (client.advanceJobPage === undefined) throw new Error("job_browser_pagination_unavailable");
        return client.advanceJobPage(ownerId, cursor, executionEpoch);
      },
      async invalidateExecution(ownerId: string, executionEpoch: number) {
        await (await getBrowserClient()).invalidateExecution?.(ownerId, executionEpoch);
      },
      releaseTask: releaseBrowserTask
    };
    const extractionCoordinator = createExtractionCoordinator({
      repository: jobMatchRepository,
      browser: jobBrowser,
      adapters: jobAdapters
    });
    const matchCoordinator = createMatchCoordinator({
      repository: jobMatchRepository,
      profileFacts: profileRepository,
      ...(embeddingSearch === undefined ? {} : { embeddingSearch })
    });
    const jobMatchService = createJobMatchService({
      repository: jobMatchRepository,
      applicationTasks: taskRepository,
      browser: jobBrowser,
      browserOwnershipLease,
      adapters: jobAdapters,
      expectationSnapshot: () => jobExpectationSnapshot(
        profileRepository.listActive(),
        profileRepository.currentRevision(),
        new Date().toISOString()
      ),
      profileRevision: () => profileRepository.currentRevision(),
      extraction: extractionCoordinator,
      matcher: matchCoordinator,
      trace: jobMatchTrace,
      prepareApplicationTask: (input) => applicationService.start(input)
    });

    return {
      database,
      embeddingTrace,
      jobMatchRepository,
      jobMatchService,
      jobMatchTrace,
      evidenceRetrieval,
      agentToolRegistry,
      profileRepository,
      originalDocumentStore: createLocalOriginalDocumentStore(originalsDirectory),
      avatarStore: createLocalAvatarStore(originalsDirectory),
      ...extraction,
      ...(structuredProvider === undefined ? {} : { selfEvaluationModelProvider: structuredProvider }),
      ...(embeddingSearch === undefined ? {} : { embeddingSearch }),
      applicationService,
      browserOwnershipLease,
      taskEvents,
      onProfileUpdated: () => applicationService.refreshFromProfile(),
      adapterHealth,
      async close() {
        if (closingDependencies) return closingDependencies;
        if (closed) return;
        shuttingDown = true;
        const operation = (async () => {
          try {
            if (recyclingBrowserClient) {
              try {
                const client = await recyclingBrowserClient;
                await client.stop();
              } catch {
                // Recycling either stopped the old Worker or failed before owning a replacement.
              }
            } else if (browserClient) {
              await (await browserClient).stop();
            }
          } finally {
            closeDatabase();
          }
        })();
        closingDependencies = operation;
        return operation;
      }
    };
  } catch (error) {
    closeDatabase();
    throw error;
  }
}

function noop(): void {}

const unavailableEvidenceRetrieval: EvidenceRetrievalPort = Object.freeze({
  async retrieve() {
    throw new LightRagRetrievalError("retrieval_unavailable", true);
  }
});

export { createProductionFieldResolver, fieldPathForApplicationAnswer } from "./applications/production-field-resolver.js";
