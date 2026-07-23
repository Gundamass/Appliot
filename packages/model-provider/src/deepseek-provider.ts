import { z } from "zod";
import type { StructuredGenerationInput, StructuredModelProvider } from "./provider.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_ESCALATION_MODEL = "deepseek-v4-pro";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 2_000;

const CompletionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }).passthrough()
  })).min(1)
}).passthrough();

export interface DeepSeekProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  escalationModel?: string;
  thinking?: "disabled";
  timeoutMs?: number;
  maxRetries?: number;
}

export interface DeepSeekProviderDependencies {
  fetch?: typeof globalThis.fetch;
  sleep?: (delayMs: number) => Promise<void>;
}

export type DeepSeekProviderErrorKind =
  | "configuration"
  | "authentication"
  | "rate_limit"
  | "network"
  | "timeout"
  | "response"
  | "validation";

export class DeepSeekProviderError extends Error {
  constructor(readonly kind: DeepSeekProviderErrorKind) {
    super(errorMessage(kind));
    this.name = "DeepSeekProviderError";
  }
}

type FailureClass = "retryable_transport" | "retryable_validation" | "fatal";

interface NormalizedConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  escalationModel: string;
  timeoutMs: number;
  maxRetries: number;
}

class ClassifiedFailure extends Error {
  constructor(readonly providerError: DeepSeekProviderError, readonly failureClass: FailureClass) {
    super(providerError.message);
  }
}

export class DeepSeekStructuredModelProvider implements StructuredModelProvider {
  private readonly config: NormalizedConfig;
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(config: DeepSeekProviderConfig, dependencies: DeepSeekProviderDependencies = {}) {
    this.config = normalizeConfig(config);
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.sleep = dependencies.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  async generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
    const flashFailure = await this.generateWithModel(this.config.defaultModel, input);
    if (flashFailure.ok) return flashFailure.value;

    if (flashFailure.failure.failureClass === "retryable_validation") {
      const escalationFailure = await this.generateWithModel(this.config.escalationModel, input);
      if (escalationFailure.ok) return escalationFailure.value;
      throw escalationFailure.failure.providerError;
    }

    throw flashFailure.failure.providerError;
  }

  private async generateWithModel<T>(model: string, input: StructuredGenerationInput<T>): Promise<
    | { ok: true; value: T }
    | { ok: false; failure: ClassifiedFailure }
  > {
    let latestFailure: ClassifiedFailure | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        return { ok: true, value: await this.request(model, input) };
      } catch (error) {
        const failure = toClassifiedFailure(error);
        latestFailure = failure;
        if (failure.failureClass === "fatal" || attempt === this.config.maxRetries) {
          return { ok: false, failure };
        }
        await this.sleep(retryDelay(attempt));
      }
    }

    throw latestFailure?.providerError ?? new DeepSeekProviderError("response");
  }

  private async request<T>(model: string, input: StructuredGenerationInput<T>): Promise<T> {
    const serializedExample = JSON.stringify(input.jsonExample);
    if (serializedExample === undefined) throw new DeepSeekProviderError("validation");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: `${input.system}\n\nReturn only valid json. Follow this example json shape exactly:\n${serializedExample}`
            },
            { role: "user", content: input.user }
          ],
          max_tokens: 8192,
          response_format: { type: "json_object" },
          thinking: { type: "disabled" }
        }),
        signal: controller.signal
      });
    } catch (error) {
      if (isAbortError(error)) throw new ClassifiedFailure(new DeepSeekProviderError("timeout"), "retryable_transport");
      throw new ClassifiedFailure(new DeepSeekProviderError("network"), "retryable_transport");
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw failureForStatus(response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ClassifiedFailure(new DeepSeekProviderError("response"), "retryable_validation");
    }

    const completion = CompletionSchema.safeParse(payload);
    if (!completion.success) throw new ClassifiedFailure(new DeepSeekProviderError("response"), "retryable_validation");

    const content = completion.data.choices[0]!.message.content;
    if (!content?.trim()) throw new ClassifiedFailure(new DeepSeekProviderError("validation"), "retryable_validation");

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ClassifiedFailure(new DeepSeekProviderError("validation"), "retryable_validation");
    }

    try {
      return input.schema.parse(parsed);
    } catch {
      throw new ClassifiedFailure(new DeepSeekProviderError("validation"), "retryable_validation");
    }
  }
}

function normalizeConfig(config: DeepSeekProviderConfig): NormalizedConfig {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const defaultModel = config.defaultModel ?? DEFAULT_MODEL;
  const escalationModel = config.escalationModel ?? DEFAULT_ESCALATION_MODEL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;

  if (
    !isNonEmptyString(config.apiKey)
    || !isHttpUrl(baseUrl)
    || !isNonEmptyString(defaultModel)
    || !isNonEmptyString(escalationModel)
    || config.thinking !== undefined && config.thinking !== "disabled"
    || !Number.isInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isInteger(maxRetries) || maxRetries < 0
  ) {
    throw new DeepSeekProviderError("configuration");
  }

  return {
    apiKey: config.apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    defaultModel,
    escalationModel,
    timeoutMs,
    maxRetries
  };
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

function failureForStatus(status: number): ClassifiedFailure {
  if (status === 401 || status === 403) {
    return new ClassifiedFailure(new DeepSeekProviderError("authentication"), "fatal");
  }
  if (status === 429) {
    return new ClassifiedFailure(new DeepSeekProviderError("rate_limit"), "retryable_transport");
  }
  if (status >= 500 && status <= 599) {
    return new ClassifiedFailure(new DeepSeekProviderError("response"), "retryable_transport");
  }
  return new ClassifiedFailure(new DeepSeekProviderError("response"), "fatal");
}

function toClassifiedFailure(error: unknown): ClassifiedFailure {
  if (error instanceof ClassifiedFailure) return error;
  if (error instanceof DeepSeekProviderError) return new ClassifiedFailure(error, "fatal");
  return new ClassifiedFailure(new DeepSeekProviderError("network"), "retryable_transport");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function retryDelay(attempt: number): number {
  return Math.min(100 * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function errorMessage(kind: DeepSeekProviderErrorKind): string {
  switch (kind) {
    case "configuration": return "DeepSeek provider configuration is invalid.";
    case "authentication": return "DeepSeek authentication failed.";
    case "rate_limit": return "DeepSeek request was rate limited.";
    case "network": return "DeepSeek request failed due to a network error.";
    case "timeout": return "DeepSeek request timed out.";
    case "response": return "DeepSeek returned an unsuccessful response.";
    case "validation": return "DeepSeek returned invalid structured output.";
  }
}
