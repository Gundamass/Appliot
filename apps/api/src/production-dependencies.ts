import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionPolicy } from "@resume/action-policy";
import { applyCertifiedHintPack, BUILT_IN_HINT_PACKS, createHintPackRegistry } from "@resume/form-semantics";
import type { CertifiedHintPack } from "@resume/contracts";
import {
  CanonicalIntentSchema,
  type AgentRunInput,
  type CanonicalIntent,
  type FormSnapshot
} from "@resume/contracts";
import { baiduJobAdapter, djiJobAdapter, jobExpectationSnapshot, mokaJobAdapter } from "@resume/job-matching";
import {
  DeepSeekStructuredModelProvider,
  EMBEDDING_INSTRUCTION_VERSION,
  type RawStructuredResponse,
  RemoteEmbeddingProvider,
  ScheduledEmbeddingProvider
} from "@resume/model-provider";
import { RemoteOcrEngine } from "@resume/profile-domain/src/pdf/remote-ocr-engine.js";
import {
  createRagService,
  validateEditedSelfEvaluation
} from "@resume/rag";
import { createApplicationTools } from "./agent/application-tools.js";
import { createAgentRuntime, type AgentRuntime } from "./agent/runtime/agent-runtime.js";
import { createApplicationAgent } from "./agent/agents/application-agent.js";
import { createJobMatchingAgent, createResumeAgent, createReviewAgent } from "./agent/agents/index.js";
import type { SpecialistAgent, SpecialistAgentInput, SpecialistAgentResult } from "./agent/agents/specialist-agent.js";
import { createSqliteAgentEventTraceSink, type AgentEventTraceSink } from "./agent/events/trace-sink.js";
import type { RuntimeExecutorInput, RuntimeExecutorResult } from "./agent/runtime/execution-loop.js";
import { createIntentResolver, type IntentResolver } from "./agent/intent/intent-resolver.js";
import { createCapabilityCatalog, type CapabilityCatalog } from "./agent/capabilities/catalog.js";
import { createCoreCapabilityDefinitions } from "./agent/capabilities/handlers/index.js";
import { createApprovalSystem, type ApprovalSystem } from "./agent/policy/approval-gate.js";
import { createPolicyEngine, type PolicyEngine } from "./agent/policy/policy-engine.js";
import { createPlanner, type Planner } from "./agent/supervisor/planner.js";
import { createSupervisor, type Supervisor } from "./agent/supervisor/supervisor.js";
import { createSqliteEvidenceStore, type EvidenceStore } from "./agent/observations/evidence-store.js";
import {
  createCallerAttestationAuthority,
  createCallerAttestationProvider,
  type CallerAttestationProvider,
  type CallerAttestationVerifier
} from "./agent/policy/caller-attestation.js";
import { SqliteAgentCheckpointer } from "./agent/sqlite-checkpointer.js";
import { createRuntimeApplicationService } from "./applications/runtime-application-service.js";
import { createGraphApplicationReviewRepository } from "./applications/graph-application-review-repository.js";
import { createApplicationTaskRepository } from "./applications/application-task-repository.js";
import { createRuntimeApplicationStateStore } from "./agent/runtime/application-state-store.js";
import { SkillRegistry } from "./application-skills/skill-registry.js";
import { bootstrapApplicationSkills } from "./application-skills/bootstrap.js";
import { createApplicationSkillRuntime } from "./application-skills/skill-selector.js";
import { SkillExecutionRecorder } from "./application-skills/skill-execution-recorder.js";
import { createSkillEvolutionAgent, type SkillEvolutionAgent } from "./application-skills/evolution-agent.js";
import { createEvolutionCoordinator, type EvolutionCoordinatorDependencies } from "./application-skills/evolution-coordinator.js";
import { createReplayCorpusPorts } from "./application-skills/replay-corpus.js";
import { evaluateExecution } from "./application-skills/evaluation-engine.js";
import { PromotionEngine } from "./application-skills/promotion-engine.js";
import { AutomaticEvolutionLoop } from "./application-skills/automatic-evolution-loop.js";
import { createFieldCoverageStore } from "./applications/field-coverage.js";
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
import { createSqliteTraceSink } from "./agent/trace-sink.js";
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
import { createStructuredJobMatchAdvisor } from "./job-matching/structured-job-match-advisor.js";
import { createJobMatchService } from "./job-matching/job-match-service.js";
import { createMatchCoordinator } from "./job-matching/match-coordinator.js";
import {
  createLightRagEvidenceRetrievalClient,
  LightRagRetrievalError,
  type EvidenceRetrievalPort,
  type EvidenceRetrievalRequest
} from "./job-matching/lightrag-retrieval-client.js";
import { BoundedJobMatchTraceBuffer } from "./observability/job-match-trace.js";
import { createDebugRawStore } from "./ats-adapters/debug-raw-store.js";
import { createAdapterLedger } from "./ats-adapters/adapter-ledger.js";
import { createAdapterReviewService } from "./ats-adapters/adapter-review-service.js";
import { createAiProposalService } from "./ats-adapters/ai-proposal-service.js";
import { createAiReplayReviewService } from "./ats-adapters/ai-replay-review-service.js";
import { SyntheticReplayRunner } from "./ats-adapters/synthetic-replay-runner.js";
import { createConversationGraph } from "./conversations/conversation-graph.js";
import { createConversationRepository } from "./conversations/conversation-repository.js";
import { createConversationProcessEventBus } from "./conversations/conversation-events.js";
import { createConversationService, type ConversationService } from "./conversations/conversation-service.js";
import {
  createConversationJobMatchService,
  type ConversationJobMatchService
} from "./conversations/conversation-job-match-service.js";
import { createTavilyRecruitmentSiteSearch } from "./recruitment-search/tavily-remote-mcp.js";
import type { RecruitmentSearchRequest, RecruitmentSiteSearchPort } from "@resume/contracts";

type ProductionBrowserClient = Pick<BrowserWorkerClient, "open" | "observe" | "execute" | "stop">
  & Partial<Pick<BrowserWorkerClient,
    "openPublic" | "invalidateExecution" | "releaseTask" | "onActivity" | "observeJob" | "applyJobFilters" | "advanceJobPage"
  >>;

export interface ProductionAdapterDependencies {
  fetch?: typeof globalThis.fetch;
  evidenceRetrievalFallback?: EvidenceRetrievalPort;
  browserClient?: ProductionBrowserClient;
  browserClientFactory?: () => Promise<ProductionBrowserClient>;
  hintPacks?: readonly CertifiedHintPack[];
  recruitmentSiteSearch?: RecruitmentSiteSearchPort;
  skillEvolutionQualification?: Pick<
    EvolutionCoordinatorDependencies,
    "safetySimulator" | "replayRunner" | "syntheticAts"
  >;
}

export interface ProductionDependencies extends AppDependencies {
  embeddingTrace: BoundedEmbeddingTraceBuffer;
  jobMatchRepository: JobMatchRepository;
  jobMatchService: ReturnType<typeof createJobMatchService>;
  jobMatchTrace: BoundedJobMatchTraceBuffer;
  browserOwnershipLease: BrowserOwnershipLease;
  evidenceRetrieval: EvidenceRetrievalPort;
  agentToolRegistry: RestrictedToolRegistry;
  /** Trusted provider for dynamic, per-run scoped caller tokens. */
  agentCallerAttestationProvider: CallerAttestationProvider;
  /** Verifier paired with the scoped tokens; never exposed to model code. */
  agentCallerAttestationVerifier: CallerAttestationVerifier;
  agentRuntime: AgentRuntime;
  agentEventTraceSink: AgentEventTraceSink;
  agentIntentResolver: IntentResolver;
  agentPlanner: Planner;
  agentSupervisor: Supervisor;
  agentCapabilityCatalog: CapabilityCatalog;
  agentPolicyEngine: PolicyEngine;
  agentApprovalSystem: ApprovalSystem;
  agentEvidenceStore: EvidenceStore;
  skillEvolutionAgent?: SkillEvolutionAgent;
  applicationSkillPromotionEngine: PromotionEngine;
  applicationSkillEvolutionLoop?: AutomaticEvolutionLoop;
  conversationService: ConversationService;
  conversationJobMatchService: ConversationJobMatchService;
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
  const debugRawStore = createDebugRawStore(database, config.atsAdapterDebug ?? { enabled: false });
  const agentTraceSink = createSqliteTraceSink(database, {
      langSmithEnabled: config.langsmith.enabled
    });
  const agentEventTraceSink = createSqliteAgentEventTraceSink(database);
  const agentCheckpointer = new SqliteAgentCheckpointer(database);
    const profileRepository = createProfileRepository(database);
    const adapterLedger = createAdapterLedger(database);
    const hintPackRegistry = createHintPackRegistry({
      builtIns: adapters.hintPacks ?? BUILT_IN_HINT_PACKS,
      local: () => adapterLedger.listCertified(),
      isRetired: (packId, version) => adapterLedger.isRetired(packId, version)
    });
    const documentRepository = createDocumentRepository(database);
    const conversationRepository = createConversationRepository(database);
    const conversationProcessEvents = createConversationProcessEventBus(database);
    const originalsDirectory = resolve(dirname(resolve(config.databaseFile)), "originals");
    const approvalKey = randomBytes(32);
    const callerAttestationAuthority = createCallerAttestationAuthority({
      signingKey: randomBytes(32),
      ttlMs: 15 * 60_000
    });
    const agentCallerAttestationProvider = createCallerAttestationProvider(callerAttestationAuthority.issuer);
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
    const seededApplicationSnapshots = new Map<string, FormSnapshot>();
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
    const observeAtsRawResponse = config.atsAdapterDebug === undefined
      ? undefined
      : (response: RawStructuredResponse) => {
          if (response.purpose === "adapter_proposal") {
            debugRawStore.retain({ proposalId: response.requestId, purpose: "proposal", plaintext: response.content });
          } else if (response.purpose === "adapter_replay_review") {
            debugRawStore.retain({ proposalId: response.requestId, purpose: "replay_review", plaintext: response.content });
          }
        };
    const baseStructuredProvider = config.deepseek === undefined
      ? undefined
      : new DeepSeekStructuredModelProvider(config.deepseek, {
          ...adapters,
          ...(observeAtsRawResponse === undefined ? {} : { observeRawResponse: observeAtsRawResponse })
        });
    const structuredProvider = baseStructuredProvider === undefined
      ? undefined
      : new ObservedStructuredModelProvider(baseStructuredProvider, adapterHealth);
  const adapterReviewService = createAdapterReviewService({
      ledger: adapterLedger,
      ...(structuredProvider === undefined || config.deepseek === undefined ? {} : {
        aiProposalService: createAiProposalService({
          provider: structuredProvider,
          ledger: adapterLedger,
          providerName: "deepseek",
          model: config.deepseek.defaultModel
        }),
        aiReplayReviewService: createAiReplayReviewService({
          provider: structuredProvider,
          ledger: adapterLedger,
          providerName: "deepseek",
          model: config.deepseek.defaultModel
        })
      }),
      replayRunner: new SyntheticReplayRunner(),
      listProfilePaths: () => profileRepository.listActive().map((fact) => fact.fieldPath),
    reviewer: "local-user"
  });
  const jobMatchAdvisor = structuredProvider === undefined
      ? undefined
      : createStructuredJobMatchAdvisor(structuredProvider);
  const skillEvolutionAgent = structuredProvider === undefined
    ? undefined
    : createSkillEvolutionAgent(structuredProvider);
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
      let cleanupSucceeded = true;
      try {
        await client.releaseTask?.(taskId);
      } catch {
        try {
          await recycleBrowserClient(client);
        } catch {
          // Releasing a task is best effort. Keep the first-open marker when
          // the failed Worker could not be recycled so the next open cannot
          // trigger an unbounded replacement/retry loop.
          cleanupSucceeded = false;
        }
      }
      if (cleanupSucceeded) {
        tasksWithOpenAttempt.delete(taskId);
        tasksWithOpenAttempt.delete(`public:${taskId}`);
      }
      seededApplicationSnapshots.delete(taskId);
    };
    const openPublicBrowser = async (taskId: string, url: string) => {
      const client = await getBrowserClient();
      if (client.openPublic === undefined) throw new Error("browser_public_open_unavailable");
      const firstOpenAttempt = !tasksWithOpenAttempt.has(`public:${taskId}`);
      tasksWithOpenAttempt.add(`public:${taskId}`);
      try {
        return await client.openPublic(taskId, url);
      } catch (error) {
        if (!firstOpenAttempt) throw error;
        const recycled = await recycleBrowserClient(client);
        if (recycled.openPublic === undefined) throw new Error("browser_public_open_unavailable");
        return recycled.openPublic(taskId, url);
      }
    };
    const applicationBrowser = {
      async open(taskId: string, url: string) {
        return openBrowser(taskId, url);
      },
      seedObservation(taskId: string, snapshot: FormSnapshot) {
        seededApplicationSnapshots.set(taskId, snapshot);
      },
      async observe(taskId: string) {
        const seeded = seededApplicationSnapshots.get(taskId);
        if (seeded !== undefined) {
          seededApplicationSnapshots.delete(taskId);
          return seeded;
        }
        return (await (await getBrowserClient()).observe(taskId)).snapshot;
      },
      async execute(command: Parameters<BrowserWorkerClient["execute"]>[0], executionEpoch?: number) {
        return (await getBrowserClient()).execute(command, executionEpoch);
      },
      async invalidateExecution(taskId: string, executionEpoch: number) {
        await (await getBrowserClient()).invalidateExecution?.(taskId, executionEpoch);
      },
      async releaseTask(taskId: string) {
        await releaseBrowserTask(taskId);
      },
      onActivity(listener: Parameters<NonNullable<BrowserWorkerClient["onActivity"]>>[0]) {
        activityListeners.set(listener, resolvedBrowserClient?.onActivity?.(listener) ?? noop);
        return () => {
          activityListeners.get(listener)?.();
          activityListeners.delete(listener);
        };
      }
    };
    const runtimeApplicationStateStore = createRuntimeApplicationStateStore(database);
    const applicationSkillRegistry = new SkillRegistry(database);
    bootstrapApplicationSkills(applicationSkillRegistry);
    const applicationSkillPromotionEngine = new PromotionEngine({ registry: applicationSkillRegistry });
    const applicationSkillEvolutionLoop = skillEvolutionAgent === undefined
      || adapters.skillEvolutionQualification === undefined
      ? undefined
      : (() => {
          const replay = createReplayCorpusPorts(applicationSkillRegistry);
          return new AutomaticEvolutionLoop({
            registry: applicationSkillRegistry,
            qualifier: createEvolutionCoordinator({
              registry: applicationSkillRegistry,
              generator: skillEvolutionAgent,
              corpus: replay.corpus,
              holdout: replay.evaluator,
              ...adapters.skillEvolutionQualification
            })
          });
        })();
    const applicationSkillExecutionRecorder = new SkillExecutionRecorder(
      {
        async append(record) {
          return applicationSkillRegistry.appendExecutionRecord(record);
        }
      },
      {
        async afterRecord({ record, requiredSemantics, auditCompleted }) {
          const report = evaluateExecution({
            record,
            requiredSemantics,
            auditCompleted,
            source: "online",
            evaluatedAt: record.completedAt
          });
          const sample = {
            record,
            evaluation: report.evaluation,
            scenarioClass: record.pageVariantId,
            requiredFieldCount: record.counts.planned,
            newAuditMismatches: record.counts.auditMismatches
          };
          await applicationSkillPromotionEngine.recordAndDecide(sample);
          await applicationSkillEvolutionLoop?.recordAndEvolve(sample).catch(() => undefined);
        }
      }
    );
    const applicationSkillRuntime = createApplicationSkillRuntime({
      registry: applicationSkillRegistry,
      bindingStoreFor(runId) {
        return {
          async get(taskId) {
            const state = await runtimeApplicationStateStore.get(runId);
            if (state === undefined || state.taskId !== taskId) return undefined;
            return state.skillBinding;
          },
          async putIfAbsent(taskId, binding) {
            return runtimeApplicationStateStore.bindSkill(runId, taskId, binding);
          }
        };
      }
    });
    const applicationFieldCoverage = createFieldCoverageStore();
    const runtimeApplicationReviews = createGraphApplicationReviewRepository(database);
    const agentEvidenceStore = createSqliteEvidenceStore(database);
    const resumeAgent = createResumeAgent({
      evidenceStore: agentEvidenceStore,
      ingestion: {
        async loadDocument() {
          const document = documentRepository.findLatestCompleted();
          if (document === undefined) throw new Error("resume_document_missing");
          return {
            documentId: document.id,
            bytes: Uint8Array.from(await readFile(document.sourcePath))
          };
        },
        extractPdf: extraction.extractPdf,
        extractFacts: extraction.extractFacts,
        profileRepository,
        traceSink: agentTraceSink
      }
    });
    const reviewAgent = createReviewAgent({
      evidenceValidator(ref, input) {
        return agentEvidenceStore.has(ref.id, {
          runId: input.runId,
          stepId: input.step.id,
          invocationId: input.step.attemptToken ?? `${input.runId}:${input.step.id}:${input.step.attempt}`
        });
      }
    });
    let jobMatchingAgent: SpecialistAgent | undefined;
    const applicationTools = createApplicationTools({
      browser: applicationBrowser,
      normalizeSnapshot(snapshot) {
        const resolution = hintPackRegistry.resolve(snapshot);
        return resolution.kind === "certified" ? applyCertifiedHintPack(snapshot, resolution.pack) : snapshot;
      },
      resolveField: async (taskId, field, phase) => {
        const resolved = await resolveApplicationField(taskId, field, phase);
        return resolved;
      },
      resolveApprovedContent(taskId, field) {
        return runtimeApplicationReviews.approvedValue(taskId, field.id);
      },
      approve(input, snapshot) {
        return actionPolicy.approve(input, snapshot).token;
      },
      resolveFileId(_taskId, field) {
        return resolveApplicationFileId(profileRepository, documentRepository, _taskId, field);
      },
      listProfileFacts() {
        return profileRepository.listActive();
      }
    });
    const applicationAgent = createApplicationAgent({
      tools: applicationTools,
      evidenceStore: agentEvidenceStore,
      profileRevision: () => profileRepository.currentRevision(),
      traceSink: agentTraceSink,
      stateStore: runtimeApplicationStateStore,
      fieldCoverage: applicationFieldCoverage,
      skillRuntime: applicationSkillRuntime,
      skillExecutionRecorder: applicationSkillExecutionRecorder,
      onContentReview({ taskId, interrupt, review }) {
        runtimeApplicationReviews.save({
          id: interrupt.interruptId,
          taskId,
          interruptId: interrupt.interruptId,
          ...review
        });
      }
    });
    const agentIntentResolver = createIntentResolver(
      structuredProvider === undefined ? {} : { structuredProvider }
    );
    const agentApprovalSystem = createApprovalSystem({
      signingKey: approvalKey,
      verifyHumanPrincipal(principal) {
        if (typeof principal !== "object" || principal === null) return undefined;
        const subject = (principal as { subject?: unknown }).subject;
        return typeof subject === "string" && subject.trim().length > 0
          ? { subject: subject.trim() }
          : undefined;
      }
    });
    const agentCapabilityCatalog = createCapabilityCatalog(createCoreCapabilityDefinitions({
      read: async (input) => input,
      transform: async (input) => input,
      reversibleAct: async () => {
        throw new Error("application_specialist_not_registered");
      },
      irreversibleAct: async () => {
        throw new Error("final_submit_requires_human_approval");
      }
    }));
    const agentPolicyEngine = createPolicyEngine({
      catalog: agentCapabilityCatalog,
      approvalGate: agentApprovalSystem.gate,
      callerAttestationVerifier: callerAttestationAuthority.verifier
    });
    const agentPlanner = createPlanner({
      // Application writes are routed to the specialist agent so the planner
      // cannot accidentally bypass its observe/authorize/readback boundary.
      availableCapabilities: agentCapabilityCatalog.names().filter((name) => name !== "application.reversible_act")
    });
    const agentSupervisor = createSupervisor();
    const agentRuntime = createAgentRuntime({
      intentResolver: agentIntentResolver,
      planner: {
        create(intent, input) {
          const planningIntent = isRuntimeApplicationTask(input)
            ? applicationScopedIntent(intent)
            : intent;
          return agentPlanner.create(planningIntent, {
            availableCapabilities: agentCapabilityCatalog.names().filter((name) => name !== "application.reversible_act")
          });
        }
      },
      supervisor: {
        decide(input) {
          return agentSupervisor.decide({
            state: input.state,
            readyStep: input.readyStep,
            signal: input.signal,
            executionEpoch: input.executionEpoch
          });
        }
      },
      executor: {
        async execute(input) {
          if (input.decision.type === "dispatch_agent" && input.decision.agent === "application_agent") {
            return applicationAgent.execute(input);
          }
          if (input.decision.type !== "dispatch_agent") {
            return {
              status: "failed",
              errorCode: "runtime_tool_dispatch_not_registered",
              toolCallsUsed: 0,
              retryable: false
            } satisfies RuntimeExecutorResult;
          }
          const agent = input.decision.agent === "resume_agent"
            ? resumeAgent
            : input.decision.agent === "job_matching_agent"
              ? jobMatchingAgent
              : input.decision.agent === "review_agent" ? reviewAgent : undefined;
          if (agent === undefined) {
            return {
              status: "failed",
              errorCode: "runtime_specialist_agent_not_registered",
              toolCallsUsed: 0,
              retryable: false
            } satisfies RuntimeExecutorResult;
          }
          return toRuntimeExecutorResult(await agent.execute(toSpecialistInput(input)));
        }
      },
      database,
      langGraphCheckpointer: agentCheckpointer,
      callerAttestation: agentCallerAttestationProvider.runtime(),
      approvalGate: agentApprovalSystem.gate,
      eventSink: agentEventTraceSink
    });
    const applicationService = createRuntimeApplicationService({
      taskRepository,
      runtime: agentRuntime,
      browser: applicationBrowser,
      stateStore: runtimeApplicationStateStore,
      fieldCoverage: applicationFieldCoverage,
      browserOwnershipLease,
      taskEvents,
      profileRevision: () => profileRepository.currentRevision(),
      reviewRepository: runtimeApplicationReviews,
      hintPackRegistry,
      adapterReviewService,
      validateContentReview(review, editedValue) {
        return validateEditedSelfEvaluation(review.original, editedValue, review.evidence);
      },
      async applyAnswers(taskId, answers, questions = []) {
        profileRepository.transaction(() => {
          for (const [questionId, value] of Object.entries(answers)) {
            const question = questions.find((candidate) => candidate.id === questionId);
            const fieldPath = question?.fieldPath ?? questionId.replace(/^field:/u, "");
            if (fieldPath.length === 0) throw new Error("answer_field_not_found");
            profileRepository.putTaskAnswer(taskId, fieldPath, value as never, [{
              documentId: "user",
              page: 1,
              text: JSON.stringify(value),
              extraction: "user"
            }]);
          }
        });
      }
    });
    const unsubscribeApplicationActivity = applicationBrowser.onActivity((activity) => {
      void applicationService.handleActivity(activity).catch(() => {
        // Worker activity must never surface a rejected promise through IPC.
      });
    });
    const jobMatchRepository = createJobMatchRepository(database);
    const jobMatchTrace = new BoundedJobMatchTraceBuffer();
    const jobAdapters = [mokaJobAdapter, djiJobAdapter, baiduJobAdapter] as const;
    const jobBrowser = {
      open: openPublicBrowser,
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
      adapters: jobAdapters,
      traceSink: agentTraceSink,
      trace: jobMatchTrace,
      toolRegistry: agentToolRegistry,
      ...(jobMatchAdvisor === undefined ? {} : { advisor: jobMatchAdvisor }),
      ...(embeddingSearch === undefined ? {} : { embeddingSearch })
    });
    jobMatchingAgent = createJobMatchingAgent({
      evidenceStore: agentEvidenceStore,
      matching: {
        repository: jobMatchRepository,
        profileFacts: profileRepository,
        adapters: jobAdapters,
        evidenceRetrieval,
        toolRegistry: agentToolRegistry,
        ...(embeddingSearch === undefined ? {} : { embeddingSearch }),
        ...(jobMatchAdvisor === undefined ? {} : { advisor: jobMatchAdvisor }),
        traceSink: agentTraceSink
      }
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
    const recruitmentSiteSearch = adapters.recruitmentSiteSearch
      ?? (config.tavily === undefined ? undefined : createTavilyRecruitmentSiteSearch(config.tavily));
    const conversationGraph = createConversationGraph({
      conversations: conversationRepository,
      jobMatchRepository,
      applicationTasks: taskRepository,
      applicationService,
      jobMatchService,
      processEvents: conversationProcessEvents,
      checkpointer: agentCheckpointer,
      traceSink: agentTraceSink,
      ...(recruitmentSiteSearch === undefined ? {} : {
        searchRecruitmentSites: (input: RecruitmentSearchRequest) => recruitmentSiteSearch.search(input)
      }),
      ...(structuredProvider === undefined ? {} : { modelProvider: structuredProvider }),
      confirmationStore: {
        put(conversationId, confirmation) {
          conversationRepository.putConfirmation(conversationId, confirmation);
        },
        peek(conversationId, confirmationId) {
          return conversationRepository.peekConfirmation(conversationId, confirmationId);
        },
        consume(conversationId, confirmationId) {
          return conversationRepository.consumeConfirmation(conversationId, confirmationId);
        }
      }
    });
    const conversationService = createConversationService({
      repository: conversationRepository,
      graph: conversationGraph,
      processEvents: conversationProcessEvents
    });
    const conversationJobMatchService = createConversationJobMatchService({
      conversations: conversationRepository,
      jobMatches: jobMatchService,
      processEvents: conversationProcessEvents
    });

    return {
      database,
      embeddingTrace,
      jobMatchRepository,
      jobMatchService,
      jobMatchTrace,
      evidenceRetrieval,
      agentToolRegistry,
      agentCallerAttestationProvider,
      agentCallerAttestationVerifier: callerAttestationAuthority.verifier,
      agentRuntime,
      agentEventTraceSink,
      agentIntentResolver,
      agentPlanner,
      agentSupervisor,
      agentCapabilityCatalog,
      agentPolicyEngine,
      agentApprovalSystem,
      agentEvidenceStore,
      ...(skillEvolutionAgent === undefined ? {} : { skillEvolutionAgent }),
      applicationSkillPromotionEngine,
      ...(applicationSkillEvolutionLoop === undefined ? {} : { applicationSkillEvolutionLoop }),
      conversationService,
      conversationJobMatchService,
      conversationProcessEvents,
      profileRepository,
      originalDocumentStore: createLocalOriginalDocumentStore(originalsDirectory),
      avatarStore: createLocalAvatarStore(originalsDirectory),
      ...extraction,
      ...(structuredProvider === undefined ? {} : { selfEvaluationModelProvider: structuredProvider }),
      ...(embeddingSearch === undefined ? {} : { embeddingSearch }),
      applicationService,
      adapterReviewService,
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
            unsubscribeApplicationActivity();
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

const APPLICATION_TASK_SUBGOALS = new Set<CanonicalIntent["subGoals"][number]>([
  "prepare_application",
  "fill_application",
  "verify_application",
  "submit_application",
  "track_application"
]);

function isRuntimeApplicationTask(input: AgentRunInput | undefined): boolean {
  return stringMetadata(input?.metadata, "applicationTaskId") !== undefined;
}

function applicationScopedIntent(intent: CanonicalIntent): CanonicalIntent {
  const subGoals = intent.subGoals.filter((subGoal) => APPLICATION_TASK_SUBGOALS.has(subGoal));
  return CanonicalIntentSchema.parse({
    ...intent,
    subGoals: subGoals.length === 0 ? ["prepare_application"] : subGoals
  });
}

function toSpecialistInput(input: RuntimeExecutorInput): SpecialistAgentInput {
  const requestMetadata = input.request?.metadata;
  const contextMetadata = input.requestContext?.metadata;
  const taskId = stringMetadata(requestMetadata, "applicationTaskId")
    ?? stringMetadata(contextMetadata, "applicationTaskId")
    ?? stringMetadata(requestMetadata, "taskId")
    ?? stringMetadata(contextMetadata, "taskId")
    ?? stringMetadata(requestMetadata, "jobMatchSessionId")
    ?? stringMetadata(contextMetadata, "jobMatchSessionId")
    ?? input.runId;
  return {
    runId: input.runId,
    taskId,
    intent: input.intent,
    plan: input.plan,
    step: input.step,
    signal: input.signal,
    executionEpoch: input.executionEpoch,
    ...(input.decision.input === undefined ? {} : { input: input.decision.input }),
    ...(input.humanResume === undefined ? {} : { humanResume: input.humanResume }),
    ...(input.callerAttestation === undefined ? {} : { callerAttestation: input.callerAttestation })
  };
}

function toRuntimeExecutorResult(result: SpecialistAgentResult): RuntimeExecutorResult {
  return {
    status: result.status,
    ...(result.pendingInterrupt === undefined ? {} : { pendingInterrupt: result.pendingInterrupt }),
    ...(result.outputRef === undefined ? {} : { outputRef: result.outputRef }),
    ...(result.evidenceRefs.length === 0 ? {} : { evidenceRefs: result.evidenceRefs }),
    ...(result.errorCode ?? result.blockReason) === undefined
      ? {}
      : { errorCode: result.errorCode ?? result.blockReason },
    toolCallsUsed: 0,
    retryable: false
  };
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function noop(): void {}

const unavailableEvidenceRetrieval: EvidenceRetrievalPort = Object.freeze({
  async retrieve() {
    throw new LightRagRetrievalError("retrieval_unavailable", true);
  }
});

export { createProductionFieldResolver, fieldPathForApplicationAnswer } from "./applications/production-field-resolver.js";

export function resolveApplicationFileId(
  profileRepository: { resolveForTask(taskId: string, fieldPath: string): { value: unknown } | undefined },
  documentRepository: { findCurrent(): { fingerprint: string } | undefined },
  taskId: string,
  field: { label: string; semanticHint?: string | undefined }
): string | undefined {
  const description = `${field.semanticHint ?? ""} ${field.label}`;
  if (/avatar|photo|头?像|照?片|证?件?照/iu.test(description)) {
    const avatar = profileRepository.resolveForTask(taskId, "basics.avatar")?.value;
    return typeof avatar === "string" && /^avatar-[0-9a-f-]+\.(?:jpg|png|webp)$/u.test(avatar)
      ? avatar
      : undefined;
  }
  const document = documentRepository.findCurrent();
  return /resume|cv|简历/iu.test(description) && document !== undefined
    ? `${document.fingerprint}.pdf`
    : undefined;
}
