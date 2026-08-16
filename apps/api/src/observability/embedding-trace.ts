export interface EmbeddingTraceEvent {
  operation: "documents" | "query" | "ontology_build" | "fact_build" | "semantic_resolution";
  cacheKeyHash?: string;
  batchSize?: number;
  queueWaitMs?: number;
  providerErrorKind?: string;
  deepSeekUsed: boolean;
  result: "succeeded" | "failed" | "unresolved";
}

export interface EmbeddingTraceSink {
  record(event: EmbeddingTraceEvent): void;
}

const TRACE_CAPACITY = 1_000;
const PROVIDER_ERROR_KINDS = new Set([
  "configuration",
  "authentication",
  "rate_limit",
  "network",
  "timeout",
  "response",
  "input",
  "count_mismatch",
  "dimension_mismatch",
  "invalid_vector",
  "unavailable",
  "unknown"
]);

export class BoundedEmbeddingTraceBuffer implements EmbeddingTraceSink {
  private readonly events: Readonly<EmbeddingTraceEvent>[] = [];

  record(event: EmbeddingTraceEvent): void {
    const sanitized = Object.freeze({
      operation: event.operation,
      ...(isSha256(event.cacheKeyHash) ? { cacheKeyHash: event.cacheKeyHash } : {}),
      ...(isPositiveInteger(event.batchSize) ? { batchSize: event.batchSize } : {}),
      ...(isNonNegativeFinite(event.queueWaitMs) ? { queueWaitMs: event.queueWaitMs } : {}),
      ...(event.providerErrorKind === undefined
        ? {}
        : { providerErrorKind: PROVIDER_ERROR_KINDS.has(event.providerErrorKind) ? event.providerErrorKind : "unknown" }),
      deepSeekUsed: event.deepSeekUsed,
      result: event.result
    });
    this.events.push(sanitized);
    if (this.events.length > TRACE_CAPACITY) this.events.splice(0, this.events.length - TRACE_CAPACITY);
  }

  snapshot(): readonly Readonly<EmbeddingTraceEvent>[] {
    return Object.freeze([...this.events]);
  }
}

function isSha256(value: string | undefined): value is string {
  return value !== undefined && /^[a-f0-9]{64}$/u.test(value);
}

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

function isNonNegativeFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}
