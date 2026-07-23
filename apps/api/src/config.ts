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

export interface ApiConfig {
  databaseFile: string;
  host: "127.0.0.1";
  port: number;
  deepseek?: DeepSeekAdapterConfig;
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

const nonNegativeInteger = z.preprocess(
  (value) => typeof value === "string" && value.trim() !== "" ? Number(value) : value,
  z.number().int().nonnegative()
);

const nonEmptyString = z.string().min(1);
const url = nonEmptyString.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
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

function invalidVariables(result: z.SafeParseError<unknown>, variables: Record<string, string>): string[] {
  const names = result.error.issues.map((issue) => issue.path[0]).filter((name): name is string => typeof name === "string");
  return [...new Set(names.map((name) => variables[name] ?? name))];
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const coreErrors: string[] = [];
  const databaseFile = env.DATABASE_FILE ?? "data/resume-assistant.sqlite";
  if (!nonEmptyString.safeParse(databaseFile).success) coreErrors.push("DATABASE_FILE");

  const portResult = positiveInteger.safeParse(env.API_PORT ?? "43120");
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

  if (coreErrors.length > 0) throw new ConfigurationError([...new Set(coreErrors)]);
  return { databaseFile, host: "127.0.0.1", port, ...(deepseek ? { deepseek } : {}) };
}
