import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionPolicy } from "@resume/action-policy";
import type { FormField } from "@resume/contracts";
import {
  DeepSeekStructuredModelProvider,
  EMBEDDING_INSTRUCTION_VERSION,
  RemoteEmbeddingProvider
} from "@resume/model-provider";
import { RemoteOcrEngine } from "@resume/profile-domain/src/pdf/remote-ocr-engine.js";
import {
  createRagService,
  validateEditedSelfEvaluation,
  type ProfileRepositoryPort,
  type RagService
} from "@resume/rag";
import { createApplicationService } from "./applications/application-service.js";
import { createCheckpointRepository } from "./applications/checkpoint-repository.js";
import {
  createFieldSemanticResolver,
  type FieldResolutionPhase,
  type FieldSemanticContext,
  type FieldSemanticResolver
} from "./applications/field-semantic-resolver.js";
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
      async applyAnswers(taskId, answers, fields) {
        profileRepository.transaction(() => {
          for (const [fieldId, value] of Object.entries(answers)) {
            const field = fields.find((candidate) => candidate.id === fieldId);
            if (!field) throw new Error("answer_field_not_found");
            const fieldPath = semanticForField(field.semanticHint, field.label);
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

interface ProductionFieldResolverDependencies {
  semanticResolver: FieldSemanticResolver;
  ragService: Pick<RagService, "resolveField">;
  profileRepository: Pick<ProfileRepositoryPort, "resolveForTask">;
}

export function createProductionFieldResolver(dependencies: ProductionFieldResolverDependencies) {
  return async (
    taskId: string,
    field: FormField,
    phase: FieldResolutionPhase = "deterministic"
  ) => {
    const semanticDecision = await dependencies.semanticResolver.resolve(
      field,
      semanticContextForField(field),
      phase
    );
    if (semanticDecision.status === "unresolved") {
      if (phase === "deterministic" && semanticDecision.reason === "exact_match_not_found") {
        return { status: "deferred" as const };
      }
      return {
        status: "needs_question" as const,
        fieldPath: field.semanticHint ?? field.id,
        question: `请补充“${field.label}”，系统未找到可安全使用的字段映射。`
      };
    }
    if (semanticDecision.status === "review") {
      const candidate = semanticDecision.candidates[0];
      return {
        status: "needs_question" as const,
        fieldPath: candidate?.semantic ?? field.semanticHint ?? field.id,
        question: semanticReviewQuestion(field.label, semanticDecision.reason)
      };
    }

    const semantic = semanticDecision.semantic;
    const existing = dependencies.profileRepository.resolveForTask(taskId, semantic);
    const decision = await dependencies.ragService.resolveField({
      taskId,
      fieldId: field.id,
      semantic,
      label: field.label,
      type: fieldTypeForRag(field.type),
      ...(field.options.length === 0 ? {} : { options: field.options }),
      validators: field.required ? ["required"] : []
    });
    const requiresContentReview = decision.status === "needs_review"
      || (semantic === "selfEvaluation" && existing?.scope !== "application");
    return {
      status: decision.status === "verified_auto" || decision.status === "needs_review"
        ? "verified" as const
        : decision.status,
      ...(decision.value === undefined ? {} : { value: decision.value }),
      ...(decision.question === undefined ? {} : { question: decision.question }),
      fieldPath: semantic,
      requiresContentReview,
      ...(!requiresContentReview ? {} : {
        contentReview: {
          original: typeof existing?.value === "string" ? existing.value : JSON.stringify(existing?.value ?? ""),
          reasons: [semantic === "selfEvaluation"
            ? "自我评价来自长期资料，填写前需要确认是否适合当前岗位。"
            : "该候选值尚未达到自动填写条件，需要你核对后采用。"],
          evidence: decision.evidence,
          unsupportedClaims: [],
          status: "needs_review" as const
        }
      })
    };
  };
}

function semanticContextForField(field: FormField): FieldSemanticContext {
  const entryContext = field.semanticHint
    ?.match(/^(education|work|projects|campus|awards|publications|certificates)\[\d+\]/u)?.[0];
  const root = (entryContext ?? field.semanticHint)?.split(/[.[\]]/u, 1)[0];
  const section = root === "identity"
    ? "basics"
    : root === "selfEvaluation"
      ? "self"
      : root && [
        "basics", "preferences", "education", "work", "projects", "campus",
        "awards", "publications", "certificates"
      ].includes(root)
        ? root
        : undefined;
  const context: FieldSemanticContext = {};
  if (section !== undefined) {
    context.section = section as NonNullable<FieldSemanticContext["section"]>;
  }
  if (entryContext !== undefined) context.entryContext = entryContext;
  return context;
}

function semanticReviewQuestion(
  label: string,
  reason: "similarity_below_threshold" | "ambiguous_candidates" | "risk_requires_review"
): string {
  if (reason === "risk_requires_review") return `请确认“${label}”，该字段涉及敏感信息或求职承诺。`;
  if (reason === "ambiguous_candidates") return `请确认“${label}”，系统找到了多个含义接近的档案字段。`;
  return `请补充“${label}”，当前字段映射置信度不足。`;
}

function fieldTypeForRag(type: "text" | "textarea" | "select" | "radio" | "checkbox" | "date" | "file") {
  if (type === "checkbox") return "boolean" as const;
  if (type === "radio") return "select" as const;
  if (type === "file") return "text" as const;
  return type;
}

function semanticForField(hint: string | undefined, label: string): string {
  const value = `${hint ?? ""} ${label}`.toLocaleLowerCase();
  if (/e-?mail|邮箱/u.test(value)) return "basics.email";
  if (/city|城市/u.test(value)) return "preferences.city";
  if (/self.?evaluation|自我评价/u.test(value)) return "selfEvaluation";
  return hint?.includes(".") ? hint : `application.${hint || "jobSpecific"}`;
}

function noop(): void {}
