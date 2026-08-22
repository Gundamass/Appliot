import { z } from "zod";

const MAX_TOP_K = 20;
const HASH = /^[a-f0-9]{64}$/u;

const RetrievalScopeSchema = z.object({
  kind: z.enum(["profile", "job"]),
  tenantScope: z.string().min(1).max(200),
  profileRevision: z.number().int().positive().optional(),
  postingId: z.string().min(1).max(200).optional()
}).strict();

const WorkerResponseSchema = z.object({
  provider: z.literal("lightrag"),
  retrievalVersion: z.string().min(1).max(200),
  scope: RetrievalScopeSchema,
  evidence: z.array(z.object({
    evidenceId: z.string().min(1).max(200),
    documentId: z.string().min(1).max(200),
    postingId: z.string().min(1).max(200).optional(),
    page: z.number().int().positive().optional(),
    blockId: z.string().min(1).max(200).optional(),
    quoteHash: z.string().regex(HASH),
    score: z.number()
  }).strict()).max(MAX_TOP_K)
}).strict();

export interface EvidenceRetrievalPort {
  retrieve(input: EvidenceRetrievalRequest): Promise<{
    provider: "lightrag" | "deterministic_fallback";
    retrievalVersion: string;
    evidence: Array<{
      evidenceId: string;
      documentId: string;
      postingId?: string;
      page?: number;
      blockId?: string;
      quoteHash: string;
      score: number;
    }>;
  }>;
}

export interface EvidenceRetrievalRequest {
  query: string;
  scope: "profile" | "job";
  profileRevision?: number;
  postingId?: string;
  topK: number;
  indexVersion?: string;
}

export interface LightRagRetrievalClientConfig {
  apiToken: string;
  baseUrl: string;
  tenantScope: string;
  timeoutMs?: number;
}

export interface LightRagRetrievalClientDependencies {
  fetch?: typeof globalThis.fetch;
  sleep?: (delayMs: number) => Promise<void>;
  fallback?: EvidenceRetrievalPort;
}

export type LightRagRetrievalErrorCode =
  | "retrieval_timeout"
  | "retrieval_unavailable"
  | "retrieval_scope_mismatch"
  | "retrieval_invalid_response"
  | "retrieval_index_missing";

export class LightRagRetrievalError extends Error {
  constructor(
    readonly code: LightRagRetrievalErrorCode,
    readonly fallbackEligible: boolean
  ) {
    super(code);
    this.name = "LightRagRetrievalError";
  }
}

interface NormalizedConfig {
  apiToken: string;
  baseUrl: string;
  tenantScope: string;
  timeoutMs: number;
}

export function createLightRagEvidenceRetrievalClient(
  config: LightRagRetrievalClientConfig,
  dependencies: LightRagRetrievalClientDependencies = {}
): EvidenceRetrievalPort {
  const normalized = normalizeConfig(config);
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  return Object.freeze({
    async retrieve(input: EvidenceRetrievalRequest) {
      const request = validateInput(input);
      try {
        const payload = await requestWithRetry(normalized, request, fetchImpl, sleep);
        return validatePayload(payload, normalized.tenantScope, request);
      } catch (error) {
        if (
          error instanceof LightRagRetrievalError
          && error.fallbackEligible
          && dependencies.fallback !== undefined
        ) {
          return await dependencies.fallback.retrieve(request);
        }
        throw error;
      }
    }
  });
}

async function requestWithRetry(
  config: NormalizedConfig,
  input: EvidenceRetrievalRequest,
  fetchImpl: typeof globalThis.fetch,
  sleep: (delayMs: number) => Promise<void>
): Promise<unknown> {
  let failure: LightRagRetrievalError | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(`${config.baseUrl}/v1/retrieve`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ ...input, tenantScope: config.tenantScope }),
          signal: controller.signal
        });
      } catch (error) {
        failure = new LightRagRetrievalError(
          isAbortError(error) ? "retrieval_timeout" : "retrieval_unavailable",
          true
        );
        if (attempt === 0) {
          await sleep(100);
          continue;
        }
        throw failure;
      }

      if (!response.ok) {
        failure = failureForStatus(response.status);
        if (attempt === 0 && failure.fallbackEligible && retryableStatus(response.status)) {
          await sleep(100);
          continue;
        }
        throw failure;
      }

      try {
        return await response.json();
      } catch {
        throw new LightRagRetrievalError("retrieval_invalid_response", false);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw failure ?? new LightRagRetrievalError("retrieval_unavailable", true);
}

function validatePayload(
  payload: unknown,
  tenantScope: string,
  input: EvidenceRetrievalRequest
): Awaited<ReturnType<EvidenceRetrievalPort["retrieve"]>> {
  const parsed = WorkerResponseSchema.safeParse(payload);
  if (!parsed.success) throw new LightRagRetrievalError("retrieval_invalid_response", false);
  const response = parsed.data;
  if (
    response.scope.kind !== input.scope
    || response.scope.tenantScope !== tenantScope
    || response.scope.profileRevision !== input.profileRevision
    || response.scope.postingId !== input.postingId
    || input.indexVersion !== undefined && response.retrievalVersion !== input.indexVersion
  ) {
    throw new LightRagRetrievalError("retrieval_scope_mismatch", false);
  }
  if (
    response.evidence.length > input.topK
    || response.evidence.some((item) => !Number.isFinite(item.score) || item.score < 0 || item.score > 1)
    || new Set(response.evidence.map((item) => item.evidenceId)).size !== response.evidence.length
    || input.scope === "job" && response.evidence.some((item) => item.postingId === undefined)
    || input.scope === "profile" && response.evidence.some((item) => item.postingId !== undefined)
  ) {
    throw new LightRagRetrievalError("retrieval_invalid_response", false);
  }
  return {
    provider: "lightrag",
    retrievalVersion: response.retrievalVersion,
    evidence: response.evidence.map((item) => ({
      evidenceId: item.evidenceId,
      documentId: item.documentId,
      ...item.postingId === undefined ? {} : { postingId: item.postingId },
      ...item.page === undefined ? {} : { page: item.page },
      ...item.blockId === undefined ? {} : { blockId: item.blockId },
      quoteHash: item.quoteHash,
      score: item.score
    }))
  };
}

function normalizeConfig(config: LightRagRetrievalClientConfig): NormalizedConfig {
  const timeoutMs = config.timeoutMs ?? 15_000;
  if (
    !nonEmpty(config.apiToken)
    || !nonEmpty(config.tenantScope)
    || !Number.isInteger(timeoutMs)
    || timeoutMs <= 0
  ) {
    throw new LightRagRetrievalError("retrieval_unavailable", false);
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(config.baseUrl);
  } catch {
    throw new LightRagRetrievalError("retrieval_unavailable", false);
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new LightRagRetrievalError("retrieval_unavailable", false);
  }
  return {
    apiToken: config.apiToken,
    baseUrl: baseUrl.toString().replace(/\/+$/u, ""),
    tenantScope: config.tenantScope,
    timeoutMs
  };
}

function validateInput(input: unknown): EvidenceRetrievalRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new LightRagRetrievalError("retrieval_invalid_response", false);
  }
  const candidate = input as Record<string, unknown>;
  const query = candidate.query;
  const scope = candidate.scope;
  const topK = candidate.topK;
  const profileRevision = candidate.profileRevision;
  const postingId = candidate.postingId;
  const indexVersion = candidate.indexVersion;
  if (
    !nonEmpty(query)
    || query.length > 2_000
    || scope !== "profile" && scope !== "job"
    || typeof topK !== "number"
    || !Number.isInteger(topK)
    || topK < 1
    || topK > MAX_TOP_K
    || profileRevision !== undefined && (typeof profileRevision !== "number" || !Number.isInteger(profileRevision) || profileRevision < 1)
    || postingId !== undefined && !nonEmpty(postingId)
    || indexVersion !== undefined && !nonEmpty(indexVersion)
    || scope === "profile" && (profileRevision === undefined || postingId !== undefined)
    || scope === "job" && profileRevision !== undefined
  ) {
    throw new LightRagRetrievalError("retrieval_invalid_response", false);
  }
  return {
    query,
    scope,
    topK,
    ...(profileRevision === undefined ? {} : { profileRevision }),
    ...(postingId === undefined ? {} : { postingId }),
    ...(indexVersion === undefined ? {} : { indexVersion })
  };
}

function failureForStatus(status: number): LightRagRetrievalError {
  if (status === 404) return new LightRagRetrievalError("retrieval_index_missing", true);
  if (status === 408 || status === 504) return new LightRagRetrievalError("retrieval_timeout", true);
  if (status === 409) return new LightRagRetrievalError("retrieval_scope_mismatch", false);
  return new LightRagRetrievalError("retrieval_unavailable", status >= 429 || status >= 500);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
