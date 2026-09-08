import { z } from "zod";
import type { OcrEngine } from "./types.js";

export const OCR_MODEL = "deepseek-ai/DeepSeek-OCR-2";
export const OCR_REVISION = "aaa02f3811945a91062062994c5c4a3f4c0af2b0";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 100;

const OcrResponseSchema = z.object({
  text: z.string().min(1),
  model: z.string(),
  modelRevision: z.string(),
  mode: z.literal("document_to_markdown"),
  elapsedMs: z.number().finite().nonnegative(),
  runtime: z.enum(["pytorch", "mindspore_lite"]),
  blocks: z.array(z.object({
    text: z.string().min(1),
    bbox: z.tuple([
      z.number().finite().int().nonnegative(),
      z.number().finite().int().nonnegative(),
      z.number().finite().int().nonnegative(),
      z.number().finite().int().nonnegative()
    ])
  }).strict()).max(10_000)
}).strict();

export type RemoteOcrDetailedResult = z.infer<typeof OcrResponseSchema>;

export interface RemoteOcrConfig {
  apiToken: string;
  baseUrl: string;
  model: string;
  modelRevision: string;
  timeoutMs?: number;
}

export interface RemoteOcrEngineDependencies {
  fetch?: typeof globalThis.fetch;
  sleep?: (delayMs: number) => Promise<void>;
}

export type RemoteOcrErrorKind =
  | "configuration"
  | "input"
  | "authentication"
  | "network"
  | "timeout"
  | "response";

export class RemoteOcrError extends Error {
  constructor(readonly kind: RemoteOcrErrorKind, readonly unavailable: boolean) {
    super(errorMessage(kind));
    this.name = "RemoteOcrError";
  }
}

interface NormalizedConfig {
  apiToken: string;
  baseUrl: string;
  model: string;
  modelRevision: string;
  timeoutMs: number;
}

class ClassifiedFailure extends Error {
  constructor(readonly ocrError: RemoteOcrError, readonly retryable: boolean) {
    super(ocrError.message);
  }
}

export class RemoteOcrEngine implements OcrEngine {
  private readonly config: NormalizedConfig;
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(config: RemoteOcrConfig, dependencies: RemoteOcrEngineDependencies = {}) {
    this.config = normalizeConfig(config);
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.sleep = dependencies.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  async recognize(image: Uint8Array): Promise<string> {
    const result = await this.recognizeDetailed(image);
    return result.text;
  }

  async recognizeDetailed(image: Uint8Array): Promise<RemoteOcrDetailedResult> {
    const contentType = imageContentType(image);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        return await this.request(image, contentType);
      } catch (error) {
        const failure = toClassifiedFailure(error);
        if (!failure.retryable) throw failure.ocrError;
        if (attempt === MAX_RETRIES) {
          if (failure.ocrError.kind === "response") throw new RemoteOcrError("response", true);
          throw failure.ocrError;
        }
        try {
          await this.sleep(RETRY_DELAY_MS);
        } catch {
          throw failure.ocrError;
        }
      }
    }

    throw new RemoteOcrError("response", false);
  }

  private async request(
    image: Uint8Array,
    contentType: "image/png" | "image/jpeg"
  ): Promise<RemoteOcrDetailedResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetch(`${this.config.baseUrl}/v1/ocr`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiToken}`,
            "Content-Type": contentType
          },
          body: image,
          signal: controller.signal
        });
      } catch (error) {
        if (isAbortError(error)) throw new ClassifiedFailure(new RemoteOcrError("timeout", true), true);
        throw new ClassifiedFailure(new RemoteOcrError("network", true), true);
      }

      if (!response.ok) throw failureForStatus(response.status);

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (isAbortError(error)) throw new ClassifiedFailure(new RemoteOcrError("timeout", true), true);
        throw new RemoteOcrError("response", false);
      }

      const parsed = OcrResponseSchema.safeParse(payload);
      if (!parsed.success) throw new RemoteOcrError("response", false);
      if (
        parsed.data.model !== this.config.model
        || parsed.data.modelRevision !== this.config.modelRevision
      ) {
        throw new RemoteOcrError("response", false);
      }

      const text = parsed.data.text.trim();
      if (text === "") throw new RemoteOcrError("response", false);
      return { ...parsed.data, text };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeConfig(config: RemoteOcrConfig): NormalizedConfig {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !isNonEmptyString(config.apiToken)
    || !isHttpUrl(config.baseUrl)
    || config.model !== OCR_MODEL
    || config.modelRevision !== OCR_REVISION
    || !Number.isInteger(timeoutMs) || timeoutMs <= 0
  ) {
    throw new RemoteOcrError("configuration", false);
  }

  return {
    apiToken: config.apiToken,
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    model: config.model,
    modelRevision: config.modelRevision,
    timeoutMs
  };
}

function imageContentType(image: Uint8Array): "image/png" | "image/jpeg" {
  if (!(image instanceof Uint8Array)) throw new RemoteOcrError("input", false);
  if (
    image.length >= 8
    && image[0] === 137
    && image[1] === 80
    && image[2] === 78
    && image[3] === 71
    && image[4] === 13
    && image[5] === 10
    && image[6] === 26
    && image[7] === 10
  ) {
    return "image/png";
  }
  if (image.length >= 3 && image[0] === 255 && image[1] === 216 && image[2] === 255) {
    return "image/jpeg";
  }
  throw new RemoteOcrError("input", false);
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
    return new ClassifiedFailure(new RemoteOcrError("authentication", false), false);
  }
  if (status >= 500 && status <= 599) {
    return new ClassifiedFailure(new RemoteOcrError("response", false), true);
  }
  return new ClassifiedFailure(new RemoteOcrError("response", false), false);
}

function toClassifiedFailure(error: unknown): ClassifiedFailure {
  if (error instanceof ClassifiedFailure) return error;
  if (error instanceof RemoteOcrError) return new ClassifiedFailure(error, false);
  return new ClassifiedFailure(new RemoteOcrError("network", true), true);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(kind: RemoteOcrErrorKind): string {
  switch (kind) {
    case "configuration": return "Remote OCR configuration is invalid.";
    case "input": return "Remote OCR input must be PNG or JPEG image bytes.";
    case "authentication": return "Remote OCR authentication failed.";
    case "network": return "Remote OCR request failed due to a network error.";
    case "timeout": return "Remote OCR request timed out.";
    case "response": return "Remote OCR worker returned an invalid response.";
  }
}
