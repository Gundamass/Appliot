import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionPolicy } from "@resume/action-policy";
import {
  DeepSeekStructuredModelProvider,
  EMBEDDING_INSTRUCTION_VERSION,
  RemoteEmbeddingProvider
} from "@resume/model-provider";
import { RemoteOcrEngine } from "@resume/profile-domain/src/pdf/remote-ocr-engine.js";
import {
  createRagService,
  validateEditedSelfEvaluation
} from "@resume/rag";
import { createApplicationService } from "./applications/application-service.js";
import { createCheckpointRepository } from "./applications/checkpoint-repository.js";
import {
  createFieldSemanticResolver
} from "./applications/field-semantic-resolver.js";
import {
  createProductionFieldResolver,
  fieldPathForApplicationAnswer
} from "./applications/production-field-resolver.js";
import { createTaskEventBus } from "./applications/task-events.js";
import { BrowserWorkerClient } from "./browser/worker-client.js";
import { createFactEmbeddingSearch } from "./rag/fact-embedding-search.js";
import { type AdapterHealthRegistry, type AppDependencies } from "./app.js";
import type { ApiConfig } from "./config.js";
import { createSqliteDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { createLocalOriginalDocumentStore } from "./profile/original-document-store.js";
import { createDocumentRepository } from "./profile/document-repository.js";
import { createProductionExtraction } from "./profile/production-extraction.js";
import { createProfileRepository } from "./profile/profile-repository.js";
import { createAdapterHealthRegistry, ObservedStructuredModelProvider } from "./health/adapter-health.js";

export interface ProductionAdapterDependencies {
  fetch?: typeof globalThis.fetch;
  browserClient?: Pick<BrowserWorkerClient, "open" | "observe" | "execute" | "stop">
    & Partial<Pick<BrowserWorkerClient, "invalidateExecution" | "onActivity">>;
}

export function createProductionDependencies(
  config: ApiConfig,
  adapters: ProductionAdapterDependencies = {}
): AppDependencies {
  const database = createSqliteDatabase(config.databaseFile);
  let closed = false;
  const close = () => {
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
    type BrowserClient = Pick<BrowserWorkerClient, "open" | "observe" | "execute" | "stop">
      & Partial<Pick<BrowserWorkerClient, "invalidateExecution" | "onActivity">>;
    let browserClient: Promise<BrowserClient> | undefined =
      adapters.browserClient === undefined ? undefined : Promise.resolve(adapters.browserClient);
    let resolvedBrowserClient: BrowserClient | undefined;
    const activityListeners = new Map<Parameters<BrowserWorkerClient["onActivity"]>[0], () => void>();
    const bundledWorkerEntry = new URL(import.meta.url).pathname.endsWith("/dist/server.js")
      ? fileURLToPath(new URL("./browser-worker.js", import.meta.url))
      : undefined;
    const getBrowserClient = async (): Promise<BrowserClient> => {
      const client = await (browserClient ??= BrowserWorkerClient.start({
        profileDir: resolve(dirname(resolve(config.databaseFile)), "browser-profile"),
        approvalKey,
        uploadDirectory: originalsDirectory,
        ...(bundledWorkerEntry === undefined ? {} : { workerEntry: bundledWorkerEntry })
      }));
      resolvedBrowserClient = client;
      for (const [listener, unsubscribe] of activityListeners) {
        if (unsubscribe === noop && client.onActivity) {
          activityListeners.set(listener, client.onActivity(listener));
        }
      }
      return client;
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
    const embeddingProvider = config.embedding === undefined
      ? undefined
      : new RemoteEmbeddingProvider(config.embedding, adapters);
    const fieldSemanticResolver = createFieldSemanticResolver({
      ...(embeddingProvider === undefined ? {} : { embeddingProvider })
    });
    const embeddingSearch = embeddingProvider === undefined
      ? undefined
      : createFactEmbeddingSearch(database, profileRepository, embeddingProvider, {
        model: config.embedding!.model,
        modelRevision: config.embedding!.modelRevision,
        dimensions: config.embedding!.dimensions,
        normalization: "l2",
        instructionVersion: EMBEDDING_INSTRUCTION_VERSION
      });
    const extraction = createProductionExtraction({
      ...(structuredProvider === undefined ? {} : { structuredProvider }),
      ...(ocrEngine === undefined ? {} : { ocrEngine })
    });
    const ragService = createRagService({
      repository: profileRepository,
      ...(embeddingSearch === undefined ? {} : { embeddingSearch })
    });
    const resolveApplicationField = createProductionFieldResolver({
      semanticResolver: fieldSemanticResolver,
      ragService,
      profileRepository
    });
    const taskEvents = createTaskEventBus(database);
    const applicationService = createApplicationService({
      checkpoints: createCheckpointRepository(database),
      taskEvents,
      browser: {
        async open(taskId, url) {
          return (await getBrowserClient()).open(taskId, url);
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
        onActivity(listener) {
          activityListeners.set(listener, resolvedBrowserClient?.onActivity?.(listener) ?? noop);
          return () => {
            activityListeners.get(listener)?.();
            activityListeners.delete(listener);
          };
        }
      },
      resolveField: resolveApplicationField,
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
      resolveFileId() {
        const document = documentRepository.findLatestCompleted();
        return document === undefined ? undefined : `${document.fingerprint}.pdf`;
      }
    });

    return {
      database,
      profileRepository,
      originalDocumentStore: createLocalOriginalDocumentStore(originalsDirectory),
      ...extraction,
      ...(structuredProvider === undefined ? {} : { selfEvaluationModelProvider: structuredProvider }),
      ...(embeddingSearch === undefined ? {} : { embeddingSearch }),
      applicationService,
      taskEvents,
      adapterHealth,
      async close() {
        if (closed) return;
        try {
          if (browserClient) await (await browserClient).stop();
        } finally {
          close();
        }
      }
    };
  } catch (error) {
    close();
    throw error;
  }
}

function noop(): void {}

export { createProductionFieldResolver, fieldPathForApplicationAnswer } from "./applications/production-field-resolver.js";
