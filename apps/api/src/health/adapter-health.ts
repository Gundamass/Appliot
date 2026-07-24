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
  getState(id: AdapterId): AdapterState;
  setDeepSeekState(state: "ready" | "unavailable"): void;
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
  let workers = initialWorkerStatuses(configuration);
  let cachedAt: number | undefined;
  let activeProbe: Promise<void> | undefined;

  const probeWorkers = async () => {
    workers = workers.map((worker) => worker.state === "unconfigured" ? worker : { ...worker, state: "checking", code: undefined });
    const probes: Array<Promise<AdapterStatus>> = [];
    if (configuration.embedding) {
      probes.push(probeWorker("embedding", configuration.embedding, fetch, probeTimeoutMs));
    }
    if (configuration.ocr) {
      probes.push(probeWorker("ocr", configuration.ocr, fetch, probeTimeoutMs));
    }
    const results = await Promise.all(probes);
    workers = (["embedding", "ocr"] as const).map((id) =>
      results.find((result) => result.id === id)
      ?? status(id, "unconfigured", undefined, undefined, "not_configured")
    );
    cachedAt = now();
  };

  return {
    async getStatuses() {
      if (cachedAt === undefined || now() - cachedAt > CACHE_MS) {
        activeProbe ??= probeWorkers().finally(() => { activeProbe = undefined; });
        await activeProbe;
      }
      return AdapterHealthResponseSchema.parse([deepseek, ...workers]);
    },
    getState(id) {
      if (id === "deepseek") return deepseek.state;
      return workers.find((worker) => worker.id === id)?.state ?? "unconfigured";
    },
    setDeepSeekState(state) {
      if (!configuration.deepseek) return;
      deepseek = status(
        "deepseek",
        state,
        configuration.deepseek.model,
        undefined,
        state === "unavailable" ? "offline" : undefined
      );
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

function initialWorkerStatuses(configuration: AdapterConfiguration): AdapterStatus[] {
  return (["embedding", "ocr"] as const).map((id) => {
    const worker = configuration[id];
    return worker
      ? status(id, "configured", worker.model, worker.modelRevision, "not_checked")
      : status(id, "unconfigured", undefined, undefined, "not_configured");
  });
}

async function probeWorker(
  id: "embedding" | "ocr",
  configuration: RemoteEmbeddingAdapterConfig | RemoteOcrAdapterConfig,
  fetch: typeof globalThis.fetch,
  timeoutMs: number
): Promise<AdapterStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const base = status(id, "configured", configuration.model, configuration.modelRevision, "not_checked");
  try {
    const response = await fetch(`${configuration.baseUrl.replace(/\/+$/u, "")}/readyz`, {
      method: "GET",
      headers: { Authorization: `Bearer ${configuration.apiToken}` },
      signal: controller.signal
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
        && readiness.data.dimensions !== undefined
        && readiness.data.dimensions !== configuration.dimensions) {
      return { ...base, state: "invalid", code: "contract_mismatch" };
    }
    return status(id, "ready", configuration.model, configuration.modelRevision);
  } catch {
    return { ...base, state: "unavailable", code: "offline" };
  } finally {
    clearTimeout(timeout);
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
