import type { EmbeddingProvider } from "./provider.js";
import {
  RemoteEmbeddingError,
  type RemoteEmbeddingErrorKind
} from "./remote-embedding-provider.js";

export interface EmbeddingSchedule {
  maxBatchSize: number;
  maxConcurrency: 1;
}

export interface EmbeddingScheduleEvent {
  kind: "documents" | "query";
  batchSize: number;
  queueWaitMs: number;
  result: "succeeded" | "failed";
  errorKind?: RemoteEmbeddingErrorKind;
}

export interface ScheduledEmbeddingProviderOptions extends EmbeddingSchedule {
  onEvent?: (event: EmbeddingScheduleEvent) => void;
}

export class ScheduledEmbeddingProvider implements EmbeddingProvider {
  private tail: Promise<void> = Promise.resolve();
  private readonly maxBatchSize: number;
  private readonly onEvent: ((event: EmbeddingScheduleEvent) => void) | undefined;

  constructor(
    private readonly delegate: EmbeddingProvider,
    options: ScheduledEmbeddingProviderOptions
  ) {
    if (!Number.isInteger(options.maxBatchSize) || options.maxBatchSize <= 0) {
      throw new Error("embedding_schedule_batch_size_invalid");
    }
    if (options.maxConcurrency !== 1) {
      throw new Error("embedding_schedule_concurrency_invalid");
    }
    this.maxBatchSize = options.maxBatchSize;
    this.onEvent = options.onEvent;
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return Promise.reject(new RemoteEmbeddingError("input"));
    }
    const batches = splitBatches(texts, this.maxBatchSize);
    const enqueuedAt = Date.now();
    return this.enqueue(async () => {
      const vectors: number[][] = [];
      for (const batch of batches) {
        const result = await this.runDelegate(
          "documents",
          batch.length,
          enqueuedAt,
          () => this.delegate.embedDocuments(batch)
        );
        if (!Array.isArray(result) || result.length !== batch.length) {
          throw new RemoteEmbeddingError("response");
        }
        vectors.push(...result);
      }
      return vectors;
    });
  }

  embedQuery(text: string): Promise<number[]> {
    const enqueuedAt = Date.now();
    return this.enqueue(() => this.runDelegate(
      "query",
      1,
      enqueuedAt,
      () => this.delegate.embedQuery(text)
    ));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async runDelegate<T>(
    kind: EmbeddingScheduleEvent["kind"],
    batchSize: number,
    enqueuedAt: number,
    operation: () => Promise<T>
  ): Promise<T> {
    const queueWaitMs = Math.max(0, Date.now() - enqueuedAt);
    try {
      const result = await operation();
      this.emit({ kind, batchSize, queueWaitMs, result: "succeeded" });
      return result;
    } catch (error) {
      this.emit({
        kind,
        batchSize,
        queueWaitMs,
        result: "failed",
        ...(error instanceof RemoteEmbeddingError ? { errorKind: error.kind } : {})
      });
      throw error;
    }
  }

  private emit(event: EmbeddingScheduleEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Diagnostics must not alter provider behavior.
    }
  }
}

function splitBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
