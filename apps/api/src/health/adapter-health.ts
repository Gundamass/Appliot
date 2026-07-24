import { AdapterHealthResponseSchema, type AdapterId, type AdapterState, type AdapterStatus } from "@resume/contracts";
import type { StructuredGenerationInput, StructuredModelProvider } from "@resume/model-provider";
import { z } from "zod";
import type { RemoteEmbeddingAdapterConfig, RemoteOcrAdapterConfig } from "../config.js";

const CACHE_MS = 5_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

const WorkerReadinessSchema = z.object({
  status: z.literal("ready"),
  model: z.string(),
  modelRevision: z.string(),
  dimensions: z.number().int().positive().optional()
}).passthrough();

interface AdapterConfiguration {
  deepseek?: { model?: string };
  embedding?: RemoteEmbeddingAdapterConfig;
  ocr?: RemoteOcrAdapterConfig;
}

interface AdapterHealthDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  probeTimeoutMs?: number;
}

export interface AdapterHealthRegistry {
  getStatuses(): Promise<AdapterStatus[]>;
  ensureFresh(id: AdapterId): Promise<AdapterStatus>;
  getState(id: AdapterId): AdapterState;
  setDeepSeekState(state: "ready" | "unavailable"): void;
  close(): void;
}

type WorkerId = "embedding" | "ocr";

interface WorkerLifecycle {
  id: WorkerId;
  configuration?: RemoteEmbeddingAdapterConfig | RemoteOcrAdapterConfig;
  status: AdapterStatus;
  cachedAt: number | undefined;
  activeProbe: Promise<AdapterStatus> | undefined;
  controller: AbortController | undefined;
  timeout: ReturnType<typeof setTimeout> | undefined;
  generation: number;
}

export function createAdapterHealthRegistry(
  configuration: AdapterConfiguration = {},
  dependencies: AdapterHealthDependencies = {}
): AdapterHealthRegistry {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const probeTimeoutMs = dependencies.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let deepseek = configuration.deepseek
    ? status("deepseek", "configured", configuration.deepseek.model, undefined, "not_checked")
    : status("deepseek", "unconfigured", undefined, undefined, "not_configured");
  const workers = createWorkerLifecycles(configuration);
  let closed = false;

  const ensureFresh = async (id: AdapterId): Promise<AdapterStatus> => {
    if (id === "deepseek") return deepseek;
    const worker = workers[id];
    if (closed || worker.configuration === undefined) return worker.status;
    if (worker.cachedAt !== undefined && now() - worker.cachedAt <= CACHE_MS) return worker.status;
    if (worker.activeProbe) return worker.activeProbe;

    worker.status = { ...worker.status, state: "checking", code: undefined };
    const generation = worker.generation;
    const controller = new AbortController();
    worker.controller = controller;
    worker.timeout = setTimeout(() => controller.abort(), probeTimeoutMs);
    const activeProbe = probeWorker(id, worker.configuration, fetch, controller.signal)
      .then((result) => {
        if (!closed && worker.generation === generation) {
          worker.status = result;
          worker.cachedAt = now();
        }
        return worker.status;
      })
      .finally(() => {
        if (worker.activeProbe === activeProbe) worker.activeProbe = undefined;
        if (worker.controller === controller) worker.controller = undefined;
        if (worker.timeout !== undefined) {
          clearTimeout(worker.timeout);
          worker.timeout = undefined;
        }
      });
    worker.activeProbe = activeProbe;
    return activeProbe;
  };

  return {
    async getStatuses() {
      const workerStatuses = await Promise.all([
        ensureFresh("embedding"),
        ensureFresh("ocr")
      ]);
      return AdapterHealthResponseSchema.parse([deepseek, ...workerStatuses]);
    },
    ensureFresh,
    getState(id) {
      if (id === "deepseek") return deepseek.state;
      return workers[id].status.state;
    },
    setDeepSeekState(state) {
      if (closed || !configuration.deepseek) return;
      deepseek = status(
        "deepseek",
        state,
        configuration.deepseek.model,
        undefined,
        state === "unavailable" ? "offline" : undefined
      );
    },
    close() {
      if (closed) return;
      closed = true;
      if (configuration.deepseek) {
        deepseek = status("deepseek", "unavailable", configuration.deepseek.model, undefined, "offline");
      }
      for (const worker of Object.values(workers)) {
        worker.generation += 1;
        worker.controller?.abort();
        if (worker.timeout !== undefined) clearTimeout(worker.timeout);
        worker.controller = undefined;
        worker.timeout = undefined;
        worker.activeProbe = undefined;
        worker.cachedAt = undefined;
        if (worker.configuration) {
          worker.status = status(worker.id, "unavailable", worker.configuration.model, worker.configuration.modelRevision, "offline");
        }
      }
    }
  };
}

export class ObservedStructuredModelProvider implements StructuredModelProvider {
  constructor(
    private readonly delegate: StructuredModelProvider,
    private readonly health: AdapterHealthRegistry
  ) {}

  async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
    try {
      const result = await this.delegate.generateStructured(input);
      this.health.setDeepSeekState("ready");
      return result;
    } catch (error) {
      this.health.setDeepSeekState("unavailable");
      throw error;
    }
  }
}

function createWorkerLifecycles(configuration: AdapterConfiguration): Record<WorkerId, WorkerLifecycle> {
  return Object.fromEntries((["embedding", "ocr"] as const).map((id) => {
    const worker = configuration[id];
    return [id, {
      id,
      ...(worker === undefined ? {} : { configuration: worker }),
      status: worker
        ? status(id, "configured", worker.model, worker.modelRevision, "not_checked")
        : status(id, "unconfigured", undefined, undefined, "not_configured"),
      cachedAt: undefined,
      activeProbe: undefined,
      controller: undefined,
      timeout: undefined,
      generation: 0
    } satisfies WorkerLifecycle];
  })) as unknown as Record<WorkerId, WorkerLifecycle>;
}

async function probeWorker(
  id: "embedding" | "ocr",
  configuration: RemoteEmbeddingAdapterConfig | RemoteOcrAdapterConfig,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal
): Promise<AdapterStatus> {
  const base = status(id, "configured", configuration.model, configuration.modelRevision, "not_checked");
  try {
    const response = await fetch(`${configuration.baseUrl.replace(/\/+$/u, "")}/readyz`, {
      method: "GET",
      headers: { Authorization: `Bearer ${configuration.apiToken}` },
      signal
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ...base, state: response.ok ? "invalid" : "unavailable", code: response.ok ? "contract_mismatch" : "not_ready" };
    }
    if (!response.ok) return { ...base, state: "unavailable", code: "not_ready" };
    const readiness = WorkerReadinessSchema.safeParse(payload);
    if (!readiness.success
      || readiness.data.model !== configuration.model
      || readiness.data.modelRevision !== configuration.modelRevision
      || id === "embedding" && "dimensions" in configuration
        && readiness.data.dimensions !== configuration.dimensions) {
      return { ...base, state: "invalid", code: "contract_mismatch" };
    }
    return status(id, "ready", configuration.model, configuration.modelRevision);
  } catch {
    return { ...base, state: "unavailable", code: "offline" };
  }
}

function status(
  id: AdapterId,
  state: AdapterState,
  model?: string,
  modelRevision?: string,
  code?: AdapterStatus["code"]
): AdapterStatus {
  return {
    id,
    state,
    ...(model === undefined ? {} : { model }),
    ...(modelRevision === undefined ? {} : { modelRevision }),
    ...(code === undefined ? {} : { code })
  };
}
