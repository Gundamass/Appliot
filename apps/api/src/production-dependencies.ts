import { dirname, resolve } from "node:path";
import {
  DeepSeekStructuredModelProvider,
  EMBEDDING_INSTRUCTION_VERSION,
  RemoteEmbeddingProvider
} from "@resume/model-provider";
import { RemoteOcrEngine } from "@resume/profile-domain/src/pdf/remote-ocr-engine.js";
import { createFactEmbeddingSearch } from "./rag/fact-embedding-search.js";
import { type AdapterHealthRegistry, type AppDependencies } from "./app.js";
import type { ApiConfig } from "./config.js";
import { createSqliteDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { createLocalOriginalDocumentStore } from "./profile/original-document-store.js";
import { createProductionExtraction } from "./profile/production-extraction.js";
import { createProfileRepository } from "./profile/profile-repository.js";

export interface ProductionAdapterDependencies {
  fetch?: typeof globalThis.fetch;
}

const unprobedAdapterHealth: AdapterHealthRegistry = {};

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
    const structuredProvider = config.deepseek === undefined
      ? undefined
      : new DeepSeekStructuredModelProvider(config.deepseek, adapters);
    const ocrEngine = config.ocr === undefined
      ? undefined
      : new RemoteOcrEngine(config.ocr, adapters);
    const embeddingProvider = config.embedding === undefined
      ? undefined
      : new RemoteEmbeddingProvider(config.embedding, adapters);
    const extraction = createProductionExtraction({
      ...(structuredProvider === undefined ? {} : { structuredProvider }),
      ...(ocrEngine === undefined ? {} : { ocrEngine })
    });

    return {
      database,
      profileRepository,
      originalDocumentStore: createLocalOriginalDocumentStore(resolve(dirname(resolve(config.databaseFile)), "originals")),
      ...extraction,
      ...(structuredProvider === undefined ? {} : { selfEvaluationModelProvider: structuredProvider }),
      ...(embeddingProvider === undefined ? {} : {
        embeddingSearch: createFactEmbeddingSearch(database, profileRepository, embeddingProvider, {
          model: config.embedding!.model,
          modelRevision: config.embedding!.modelRevision,
          dimensions: config.embedding!.dimensions,
          normalization: "l2",
          instructionVersion: EMBEDDING_INSTRUCTION_VERSION
        })
      }),
      adapterHealth: unprobedAdapterHealth,
      close
    };
  } catch (error) {
    close();
    throw error;
  }
}
