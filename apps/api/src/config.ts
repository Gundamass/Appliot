import { z } from "zod";

export interface DeepSeekAdapterConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  escalationModel: string;
  thinking: "disabled";
  timeoutMs: number;
  maxRetries: number;
}

export interface RemoteEmbeddingAdapterConfig {
  apiToken: string;
  baseUrl: string;
  model: string;
  modelRevision: string;
  dimensions: number;
  timeoutMs: number;
}

export interface RemoteOcrAdapterConfig {
  apiToken: string;
  baseUrl: string;
  model: string;
  modelRevision: string;
  timeoutMs: number;
}

export interface AtsAdapterDebugConfig {
  enabled: true;
  encryptionKey: Buffer;
  ttlHours: number;
}

export interface ApiConfig {
  databaseFile: string;
  host: "127.0.0.1";
  port: number;
  deepseek?: DeepSeekAdapterConfig;
  embedding?: RemoteEmbeddingAdapterConfig;
  ocr?: RemoteOcrAdapterConfig;
  atsAdapterDebug?: AtsAdapterDebugConfig;
}

export class ConfigurationError extends Error {
  constructor(readonly variables: string[]) {
    super(`Invalid configuration: ${variables.join(", ")}`);
    this.name = "ConfigurationError";
  }
}

const positiveInteger = z.preprocess(
  (value) => typeof value === "string" && value.trim() !== "" ? Number(value) : value,
  z.number().int().positive()
);
const tcpPort = positiveInteger.refine((value) => value <= 65_535);
const debugTtlHours = positiveInteger.refine((value) => value <= 168);

const nonNegativeInteger = z.preprocess(
  (value) => typeof value === "string" && value.trim() !== "" ? Number(value) : value,
  z.number().int().nonnegative()
);

const nonEmptyString = z.string().min(1);
const url = nonEmptyString.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
});
const loopbackTunnelUrl = (port: number) => nonEmptyString.url().refine((value) => {
  const parsed = new URL(value);
  const bareOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  return parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    && parsed.port === String(port)
    && parsed.username === ""
    && parsed.password === ""
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === ""
    && (bareOrigins.has(value) || bareOrigins.has(value.slice(0, -1)) && value.endsWith("/"));
});

const deepSeekSchema = z.object({
  apiKey: nonEmptyString,
  baseUrl: url,
  defaultModel: nonEmptyString,
  escalationModel: nonEmptyString,
  thinking: z.literal("disabled"),
  timeoutMs: positiveInteger,
  maxRetries: nonNegativeInteger
});

const embeddingSchema = z.object({
  apiToken: nonEmptyString,
  baseUrl: loopbackTunnelUrl(18080),
  model: z.literal("Qwen/Qwen3-Embedding-8B"),
  modelRevision: z.literal("1d8ad4ca9b3dd8059ad90a75d4983776a23d44af"),
  dimensions: positiveInteger.refine((value) => value === 4096),
  timeoutMs: positiveInteger
});

const ocrSchema = z.object({
  apiToken: nonEmptyString,
  baseUrl: loopbackTunnelUrl(43121),
  model: z.literal("deepseek-ai/DeepSeek-OCR-2"),
  modelRevision: z.literal("aaa02f3811945a91062062994c5c4a3f4c0af2b0"),
  timeoutMs: positiveInteger
});

function invalidVariables(result: z.SafeParseError<unknown>, variables: Record<string, string>): string[] {
  const names = result.error.issues.map((issue) => issue.path[0]).filter((name): name is string => typeof name === "string");
  return [...new Set(names.map((name) => variables[name] ?? name))];
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const coreErrors: string[] = [];
  const databaseFile = env.DATABASE_FILE ?? "data/resume-assistant.sqlite";
  if (!nonEmptyString.safeParse(databaseFile).success) coreErrors.push("DATABASE_FILE");

  const portResult = tcpPort.safeParse(env.API_PORT ?? "43120");
  const port = portResult.success ? portResult.data : 0;
  if (!portResult.success) coreErrors.push("API_PORT");

  const hasDeepSeek = Object.keys(env).some((name) => name.startsWith("DEEPSEEK_"));
  let deepseek: DeepSeekAdapterConfig | undefined;
  if (hasDeepSeek) {
    const values = {
      apiKey: env.DEEPSEEK_API_KEY,
      baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      defaultModel: env.DEEPSEEK_MODEL_DEFAULT ?? "deepseek-v4-flash",
      escalationModel: env.DEEPSEEK_MODEL_ESCALATION ?? "deepseek-v4-pro",
      thinking: env.DEEPSEEK_THINKING ?? "disabled",
      timeoutMs: env.DEEPSEEK_TIMEOUT_MS ?? "60000",
      maxRetries: env.DEEPSEEK_MAX_RETRIES ?? 2
    };
    const result = deepSeekSchema.safeParse(values);
    if (!result.success) {
      const variables = invalidVariables(result, {
        apiKey: "DEEPSEEK_API_KEY",
        baseUrl: "DEEPSEEK_BASE_URL",
        defaultModel: "DEEPSEEK_MODEL_DEFAULT",
        escalationModel: "DEEPSEEK_MODEL_ESCALATION",
        thinking: "DEEPSEEK_THINKING",
        timeoutMs: "DEEPSEEK_TIMEOUT_MS",
        maxRetries: "DEEPSEEK_MAX_RETRIES"
      });
      coreErrors.push(...variables);
    } else {
      deepseek = result.data;
    }
  }

  const hasEmbedding = Object.keys(env).some((name) => name.startsWith("EMBEDDING_"));
  let embedding: RemoteEmbeddingAdapterConfig | undefined;
  if (hasEmbedding) {
    const result = embeddingSchema.safeParse({
      apiToken: env.EMBEDDING_API_TOKEN,
      baseUrl: env.EMBEDDING_BASE_URL,
      model: env.EMBEDDING_MODEL,
      modelRevision: env.EMBEDDING_MODEL_REVISION,
      dimensions: env.EMBEDDING_DIMENSIONS,
      timeoutMs: env.EMBEDDING_TIMEOUT_MS ?? "60000"
    });
    if (!result.success) {
      coreErrors.push(...invalidVariables(result, {
        apiToken: "EMBEDDING_API_TOKEN",
        baseUrl: "EMBEDDING_BASE_URL",
        model: "EMBEDDING_MODEL",
        modelRevision: "EMBEDDING_MODEL_REVISION",
        dimensions: "EMBEDDING_DIMENSIONS",
        timeoutMs: "EMBEDDING_TIMEOUT_MS"
      }));
    } else {
      embedding = result.data;
    }
  }

  const hasOcr = Object.keys(env).some((name) => name.startsWith("OCR_"));
  let ocr: RemoteOcrAdapterConfig | undefined;
  if (hasOcr) {
    const result = ocrSchema.safeParse({
      apiToken: env.OCR_API_TOKEN,
      baseUrl: env.OCR_BASE_URL,
      model: env.OCR_MODEL,
      modelRevision: env.OCR_MODEL_REVISION,
      timeoutMs: env.OCR_TIMEOUT_MS ?? "180000"
    });
    if (!result.success) {
      coreErrors.push(...invalidVariables(result, {
        apiToken: "OCR_API_TOKEN",
        baseUrl: "OCR_BASE_URL",
        model: "OCR_MODEL",
        modelRevision: "OCR_MODEL_REVISION",
        timeoutMs: "OCR_TIMEOUT_MS"
      }));
    } else {
      ocr = result.data;
    }
  }

  const hasAtsAdapterDebug = Object.keys(env).some((name) => name.startsWith("ATS_ADAPTER_DEBUG_"));
  let atsAdapterDebug: AtsAdapterDebugConfig | undefined;
  if (hasAtsAdapterDebug) {
    const debugErrors: string[] = [];
    if (env.ATS_ADAPTER_DEBUG_RAW !== "1") debugErrors.push("ATS_ADAPTER_DEBUG_RAW");
    const encodedKey = env.ATS_ADAPTER_DEBUG_KEY_BASE64;
    const encryptionKey = typeof encodedKey === "string" ? Buffer.from(encodedKey, "base64") : undefined;
    if (encryptionKey?.byteLength !== 32) debugErrors.push("ATS_ADAPTER_DEBUG_KEY_BASE64");
    const ttlResult = debugTtlHours.safeParse(env.ATS_ADAPTER_DEBUG_TTL_HOURS ?? "24");
    if (!ttlResult.success) debugErrors.push("ATS_ADAPTER_DEBUG_TTL_HOURS");
    coreErrors.push(...debugErrors);
    if (debugErrors.length === 0 && encryptionKey && ttlResult.success) {
      atsAdapterDebug = { enabled: true, encryptionKey, ttlHours: ttlResult.data };
    }
  }

  if (coreErrors.length > 0) throw new ConfigurationError([...new Set(coreErrors)]);
  return {
    databaseFile,
    host: "127.0.0.1",
    port,
    ...(deepseek ? { deepseek } : {}),
    ...(embedding ? { embedding } : {}),
    ...(ocr ? { ocr } : {}),
    ...(atsAdapterDebug ? { atsAdapterDebug } : {})
  };
}
