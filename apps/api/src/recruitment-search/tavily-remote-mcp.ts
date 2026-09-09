import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RecruitmentSearchRequestSchema, RecruitmentSiteSearchResultSchema } from "@resume/contracts";
import type {
  RecruitmentSearchRequest,
  RecruitmentSiteSearchPort,
  RecruitmentSiteSearchResult
} from "@resume/contracts";
import { z } from "zod";
import type { TavilyRemoteMcpConfig } from "../config.js";
import { validatePublicHttpsUrl, type HostnameResolver } from "./public-https-url.js";

const TAVILY_SEARCH_TOOL = "tavily_search" as const;
const MAX_REMOTE_RESULTS = 5;
const MAX_SAFE_CANDIDATES = 3;
const MAX_TEXT_CONTENT_BYTES = 256 * 1024;
const RETRY_DELAY_MS = 200;

const RECRUITMENT_LABELS = {
  campus: "校园招聘",
  social: "社会招聘",
  internship: "实习招聘",
  unknown: "招聘"
} as const;

const TavilyResultItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  score: z.number().finite().optional()
}).passthrough();

const TavilyResponseSchema = z.object({
  results: z.array(TavilyResultItemSchema)
}).passthrough();

export type TavilyTransportErrorKind =
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "network"
  | "http"
  | "protocol";

export class TavilyTransportError extends Error {
  constructor(readonly kind: TavilyTransportErrorKind, readonly status?: number) {
    super(kind);
    this.name = "TavilyTransportError";
  }
}

export type TavilySearchErrorCode =
  | "TAVILY_TIMEOUT"
  | "TAVILY_UNAVAILABLE"
  | "TAVILY_PROTOCOL_ERROR"
  | "NO_SAFE_CANDIDATE";

export class TavilySearchError extends Error {
  constructor(readonly code: TavilySearchErrorCode) {
    super(code);
    this.name = "TavilySearchError";
  }
}

export interface TavilyMcpCallAdapter {
  callTool(
    name: typeof TAVILY_SEARCH_TOOL,
    args: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown>;
}

export interface TavilySearchAdapters {
  callTool?: TavilyMcpCallAdapter["callTool"];
  resolveHostname?: HostnameResolver;
  delay?: (milliseconds: number) => Promise<void>;
}

export function createTavilyRecruitmentSiteSearch(
  config: TavilyRemoteMcpConfig,
  adapters: TavilySearchAdapters = {}
): RecruitmentSiteSearchPort {
  const normalizedConfig = normalizeConfig(config);
  const callTool = adapters.callTool ?? createRemoteMcpCallTool(normalizedConfig);
  const resolveHostname = adapters.resolveHostname;
  const delay = adapters.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));

  return Object.freeze({
    async search(input: RecruitmentSearchRequest): Promise<RecruitmentSiteSearchResult> {
      const request = RecruitmentSearchRequestSchema.safeParse(input);
      if (!request.success) throw new TavilySearchError("TAVILY_PROTOCOL_ERROR");

      const query = buildQuery(request.data);
      const response = await callWithRetry(
        callTool,
        fixedArguments(query),
        normalizedConfig,
        delay
      );
      const remoteResults = parseTavilyResponse(response);
      const candidates = await normalizeCandidates(remoteResults, resolveHostname);
      if (candidates.length === 0) throw new TavilySearchError("NO_SAFE_CANDIDATE");

      const result = RecruitmentSiteSearchResultSchema.safeParse({ query, candidates });
      if (!result.success) throw new TavilySearchError("TAVILY_PROTOCOL_ERROR");
      return result.data;
    }
  });
}

function buildQuery(input: RecruitmentSearchRequest): string {
  return `${input.companyName} ${RECRUITMENT_LABELS[input.recruitmentType]} 招聘 官网`;
}

function fixedArguments(query: string): Record<string, unknown> {
  return {
    query,
    search_depth: "basic",
    topic: "general",
    max_results: MAX_REMOTE_RESULTS,
    include_images: false,
    include_raw_content: false
  };
}

async function callWithRetry(
  callTool: TavilyMcpCallAdapter["callTool"],
  args: Record<string, unknown>,
  config: TavilyRemoteMcpConfig,
  delay: (milliseconds: number) => Promise<void>
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    try {
      return await callTool(TAVILY_SEARCH_TOOL, args, config.timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < config.maxRetries && isRetryable(error)) {
        try {
          await delay(RETRY_DELAY_MS);
        } catch {
          throw mapSearchError(error);
        }
        continue;
      }
      throw mapSearchError(error);
    }
  }
  throw mapSearchError(lastError);
}

function parseTavilyResponse(response: unknown): Array<z.infer<typeof TavilyResultItemSchema>> {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new TavilySearchError("TAVILY_PROTOCOL_ERROR");
  }

  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new TavilySearchError("TAVILY_PROTOCOL_ERROR");
  const textContent = content.find((item): item is { type: "text"; text: string } => (
    typeof item === "object"
    && item !== null
    && (item as { type?: unknown }).type === "text"
    && typeof (item as { text?: unknown }).text === "string"
  ));
  if (textContent === undefined) throw new TavilySearchError("TAVILY_PROTOCOL_ERROR");
  if (utf8ByteLength(textContent.text) > MAX_TEXT_CONTENT_BYTES) {
    throw new TavilySearchError("TAVILY_PROTOCOL_ERROR");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(textContent.text);
  } catch {
    throw new TavilySearchError("TAVILY_PROTOCOL_ERROR");
  }
  const parsed = TavilyResponseSchema.safeParse(decoded);
  if (!parsed.success) throw new TavilySearchError("TAVILY_PROTOCOL_ERROR");
  return parsed.data.results.slice(0, MAX_REMOTE_RESULTS);
}

async function normalizeCandidates(
  remoteResults: Array<z.infer<typeof TavilyResultItemSchema>>,
  resolveHostname?: HostnameResolver
): Promise<RecruitmentSiteSearchResult["candidates"]> {
  const candidates: RecruitmentSiteSearchResult["candidates"] = [];
  const seenUrls = new Set<string>();

  for (const remoteResult of remoteResults) {
    const title = plainText(remoteResult.title).slice(0, 160);
    if (title === "") continue;

    let verified: { url: string; domain: string };
    try {
      verified = await validatePublicHttpsUrl(remoteResult.url, resolveHostname);
    } catch {
      continue;
    }
    // Search results identify recruitment entry pages, where fragments are
    // navigation noise for ranking/deduplication. Application task targets use
    // validatePublicHttpsUrl directly and intentionally preserve hash routes.
    const candidateUrl = new URL(verified.url);
    candidateUrl.hash = "";
    const normalizedCandidateUrl = candidateUrl.toString();
    if (seenUrls.has(normalizedCandidateUrl)) continue;
    seenUrls.add(normalizedCandidateUrl);

    const snippet = plainText(remoteResult.content).slice(0, 500);
    const sourceScore = remoteResult.score !== undefined
      && remoteResult.score >= 0
      && remoteResult.score <= 1
      ? remoteResult.score
      : undefined;
    candidates.push({
      title,
      url: normalizedCandidateUrl,
      domain: verified.domain,
      snippet,
      source: "tavily",
      ...(sourceScore === undefined ? {} : { sourceScore })
    });
    if (candidates.length >= MAX_SAFE_CANDIDATES) break;
  }

  return candidates;
}

function plainText(value: string): string {
  return value
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function normalizeConfig(config: TavilyRemoteMcpConfig): TavilyRemoteMcpConfig {
  if (
    typeof config.apiKey !== "string"
    || config.apiKey.trim() === ""
    || typeof config.endpoint !== "string"
    || typeof config.timeoutMs !== "number"
    || !Number.isInteger(config.timeoutMs)
    || config.timeoutMs <= 0
    || config.maxRetries !== 1
  ) {
    throw new TavilySearchError("TAVILY_PROTOCOL_ERROR");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new TavilySearchError("TAVILY_PROTOCOL_ERROR");
  }
  if (
    endpoint.protocol !== "https:"
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.search !== ""
    || endpoint.hash !== ""
  ) {
    throw new TavilySearchError("TAVILY_PROTOCOL_ERROR");
  }

  return { ...config, endpoint: endpoint.toString() };
}

function isRetryable(error: unknown): boolean {
  return error instanceof TavilyTransportError
    && (error.kind === "rate_limited" || error.kind === "server_error" || error.kind === "network");
}

function mapSearchError(error: unknown): TavilySearchError {
  if (error instanceof TavilySearchError) return error;
  if (error instanceof TavilyTransportError) {
    if (error.kind === "timeout") return new TavilySearchError("TAVILY_TIMEOUT");
    if (error.kind === "rate_limited" || error.kind === "server_error" || error.kind === "network") {
      return new TavilySearchError("TAVILY_UNAVAILABLE");
    }
  }
  return new TavilySearchError("TAVILY_PROTOCOL_ERROR");
}

function createRemoteMcpCallTool(config: TavilyRemoteMcpConfig): TavilyMcpCallAdapter["callTool"] {
  return async (name, args, timeoutMs) => {
    if (name !== TAVILY_SEARCH_TOOL) {
      throw new TavilyTransportError("http", 400);
    }

    const endpoint = new URL(config.endpoint);
    endpoint.searchParams.set("tavilyApiKey", config.apiKey);
    const client = new Client({
      name: "resume-application-assistant",
      version: "1.0.0"
    });
    const transport = new StreamableHTTPClientTransport(endpoint);
    try {
      // SDK 1.30.0 exposes the same transport contract through two declarations
      // that differ under exactOptionalPropertyTypes.
      const clientTransport = transport as unknown as Parameters<Client["connect"]>[0];
      await client.connect(clientTransport, { timeout: timeoutMs });
      return await client.callTool(
        { name: TAVILY_SEARCH_TOOL, arguments: args },
        undefined,
        { timeout: timeoutMs }
      );
  } catch (error) {
    throw classifyRemoteError(error);
    } finally {
      try {
        await client.close();
      } catch {
        // Closing a failed transport must not expose transport details.
      }
    }
  };
}

function classifyRemoteError(error: unknown): TavilyTransportError {
  if (error instanceof TavilyTransportError) return error;

  if (isTimeoutError(error)) return new TavilyTransportError("timeout");
  const status = statusFromError(error);
  if (status === 408) return new TavilyTransportError("timeout", status);
  if (status === 429) return new TavilyTransportError("rate_limited", status);
  if (status !== undefined && status >= 500 && status <= 599) {
    return new TavilyTransportError("server_error", status);
  }
  if (isMcpProtocolError(error)) return new TavilyTransportError("protocol");
  return new TavilyTransportError("network");
}

function statusFromError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as { status?: unknown; code?: unknown };
  if (typeof record.status === "number" && Number.isInteger(record.status)) return record.status;
  if (typeof record.code === "number" && Number.isInteger(record.code) && record.code >= 100 && record.code <= 599) {
    return record.code;
  }
  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /\btimeout\b|\btimed out\b/iu.test(error.message);
}

function isMcpProtocolError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "McpError" || error.name === "StreamableHTTPError") return true;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" && code < 0;
}
