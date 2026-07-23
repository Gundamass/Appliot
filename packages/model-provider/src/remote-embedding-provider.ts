import { z } from "zod";
import type { EmbeddingProvider } from "./provider.js";

const PINNED_MODEL = "Qwen/Qwen3-Embedding-8B";
const PINNED_MODEL_REVISION = "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 2_000;
const MAX_BATCH_SIZE = 32;
const MAX_INPUT_LENGTH = 30_000;
const NORM_TOLERANCE = 1e-3;

const EmbeddingResponseSchema = z.object({
  model: z.string(),
  modelRevision: z.string(),
  dimensions: z.number().int().positive(),
  data: z.array(z.object({
    index: z.number().int().nonnegative(),
    embedding: z.array(z.number())
  }).strict())
}).strict();

export const EMBEDDING_QUERY_INSTRUCTION =
  "Retrieve verified resume facts relevant to completing a job application field.";
export const EMBEDDING_INSTRUCTION_VERSION = "resume-fact-query-v1";

export interface RemoteEmbeddingConfig {
  apiToken: string;
  baseUrl: string;
  model: string;
  modelRevision: string;
  dimensions: number;
  timeoutMs?: number;
}

export interface RemoteEmbeddingProviderDependencies {
  fetch?: typeof globalThis.fetch;
  sleep?: (delayMs: number) => Promise<void>;
  parseResponse?: (response: Response) => Promise<unknown>;
}

export type RemoteEmbeddingErrorKind =
  | "configuration"
  | "input"
  | "authentication"
  | "rate_limit"
  | "network"
  | "timeout"
  | "response";

export class RemoteEmbeddingError extends Error {
  constructor(readonly kind: RemoteEmbeddingErrorKind) {
    super(errorMessage(kind));
    this.name = "RemoteEmbeddingError";
  }
}

interface NormalizedConfig {
  apiToken: string;
  baseUrl: string;
  model: string;
  modelRevision: string;
  dimensions: number;
  timeoutMs: number;
}

class ClassifiedFailure extends Error {
  constructor(readonly providerError: RemoteEmbeddingError, readonly retryable: boolean) {
    super(providerError.message);
  }
}

export class RemoteEmbeddingProvider implements EmbeddingProvider {
  private readonly config: NormalizedConfig;
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly parseResponse: (response: Response) => Promise<unknown>;

  constructor(config: RemoteEmbeddingConfig, dependencies: RemoteEmbeddingProviderDependencies = {}) {
    this.config = normalizeConfig(config);
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.sleep = dependencies.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.parseResponse = dependencies.parseResponse ?? ((response) => response.json());
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts);
  }

  async embedQuery(text: string): Promise<number[]> {
    validateTexts([text]);
    const [vector] = await this.embed([
      `Instruct: ${EMBEDDING_QUERY_INSTRUCTION}\nQuery: ${text}`
    ]);
    if (!vector) throw new RemoteEmbeddingError("response");
    return vector;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    validateTexts(texts);
    let latestFailure: ClassifiedFailure | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        return await this.request(texts);
      } catch (error) {
        const failure = toClassifiedFailure(error);
        latestFailure = failure;
        if (!failure.retryable || attempt === MAX_RETRIES) throw failure.providerError;
        try {
          await this.sleep(retryDelay(attempt));
        } catch {
          throw failure.providerError;
        }
      }
    }

    throw latestFailure?.providerError ?? new RemoteEmbeddingError("response");
  }

  private async request(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(`${this.config.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: this.config.model, input: texts }),
        signal: controller.signal
      });
    } catch (error) {
      if (isAbortError(error)) throw new ClassifiedFailure(new RemoteEmbeddingError("timeout"), true);
      throw new ClassifiedFailure(new RemoteEmbeddingError("network"), true);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw failureForStatus(response.status);

    let payload: unknown;
    try {
      payload = await this.parseResponse(response);
    } catch {
      throw new RemoteEmbeddingError("response");
    }

    const parsed = EmbeddingResponseSchema.safeParse(payload);
    if (!parsed.success) throw new RemoteEmbeddingError("response");
    if (
      parsed.data.model !== this.config.model
      || parsed.data.modelRevision !== this.config.modelRevision
      || parsed.data.dimensions !== this.config.dimensions
      || parsed.data.data.length !== texts.length
    ) {
      throw new RemoteEmbeddingError("response");
    }

    const vectors = [...parsed.data.data].sort((left, right) => left.index - right.index);
    if (vectors.some((entry, index) => entry.index !== index)) {
      throw new RemoteEmbeddingError("response");
    }

    for (const { embedding } of vectors) {
      if (
        embedding.length !== this.config.dimensions
        || embedding.some((value) => !Number.isFinite(value))
        || Math.abs(vectorNorm(embedding) - 1) > NORM_TOLERANCE
      ) {
        throw new RemoteEmbeddingError("response");
      }
    }

    return vectors.map(({ embedding }) => [...embedding]);
  }
}

function normalizeConfig(config: RemoteEmbeddingConfig): NormalizedConfig {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !isNonEmptyString(config.apiToken)
    || !isHttpUrl(config.baseUrl)
    || config.model !== PINNED_MODEL
    || config.modelRevision !== PINNED_MODEL_REVISION
    || !Number.isInteger(config.dimensions) || config.dimensions <= 0
    || !Number.isInteger(timeoutMs) || timeoutMs <= 0
  ) {
    throw new RemoteEmbeddingError("configuration");
  }

  return {
    apiToken: config.apiToken,
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    model: config.model,
    modelRevision: config.modelRevision,
    dimensions: config.dimensions,
    timeoutMs
  };
}

function validateTexts(texts: string[]): void {
  if (
    texts.length === 0
    || texts.length > MAX_BATCH_SIZE
    || texts.some((text) => typeof text !== "string" || text.trim() === "" || text.length > MAX_INPUT_LENGTH)
  ) {
    throw new RemoteEmbeddingError("input");
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function vectorNorm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
}

function failureForStatus(status: number): ClassifiedFailure {
  if (status === 401) return new ClassifiedFailure(new RemoteEmbeddingError("authentication"), false);
  if (status === 429) return new ClassifiedFailure(new RemoteEmbeddingError("rate_limit"), true);
  if (status >= 500 && status <= 599) return new ClassifiedFailure(new RemoteEmbeddingError("response"), true);
  return new ClassifiedFailure(new RemoteEmbeddingError("response"), false);
}

function toClassifiedFailure(error: unknown): ClassifiedFailure {
  if (error instanceof ClassifiedFailure) return error;
  if (error instanceof RemoteEmbeddingError) return new ClassifiedFailure(error, false);
  return new ClassifiedFailure(new RemoteEmbeddingError("network"), true);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function retryDelay(attempt: number): number {
  return Math.min(100 * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function errorMessage(kind: RemoteEmbeddingErrorKind): string {
  switch (kind) {
    case "configuration": return "Remote embedding provider configuration is invalid.";
    case "input": return "Remote embedding input is invalid.";
    case "authentication": return "Remote embedding authentication failed.";
    case "rate_limit": return "Remote embedding request was rate limited.";
    case "network": return "Remote embedding request failed due to a network error.";
    case "timeout": return "Remote embedding request timed out.";
    case "response": return "Remote embedding worker returned an invalid response.";
  }
}
