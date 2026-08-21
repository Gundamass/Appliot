import type { LangSmithOutbox, LangSmithOutboxItem, LangSmithReviewEvent } from "./langsmith-outbox.js";

export interface LangSmithClient {
  createRun(event: LangSmithReviewEvent, idempotencyKey?: string): Promise<{ id: string }>;
  updateRun?(remoteRunId: string, event: LangSmithReviewEvent, idempotencyKey?: string): Promise<void>;
  deleteRun?(remoteRunId: string): Promise<void>;
}

export interface LangSmithExporter {
  flushOnce(): Promise<{ sent: number; retried: number; deadLetter: number }>;
  deleteRemoteRuns(remoteRunIds: readonly string[]): Promise<void>;
}

export interface LangSmithExporterOptions {
  client: LangSmithClient;
  outbox: LangSmithOutbox;
  maxAttempts?: number;
  batchSize?: number;
}

export function createLangSmithExporter(options: LangSmithExporterOptions): LangSmithExporter {
  const maxAttempts = options.maxAttempts ?? 3;
  const batchSize = options.batchSize ?? 20;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("langsmith_max_attempts_invalid");

  return {
    async flushOnce() {
      const claimed = options.outbox.claim(batchSize);
      let sent = 0;
      let retried = 0;
      let deadLetter = 0;
      for (const item of claimed) {
        try {
          const remote = item.remoteRunId !== undefined && options.client.updateRun !== undefined
            ? await updateExisting(options.client, item)
            : await options.client.createRun(item.event, item.traceId);
          options.outbox.markSent(item.id, remote?.id ?? item.remoteRunId ?? "remote_accepted");
          sent += 1;
        } catch (error) {
          const result = options.outbox.markFailed(item.id, classifyRemoteError(error));
          if (result.status === "dead_letter" || result.attempts >= maxAttempts) deadLetter += 1;
          else retried += 1;
        }
      }
      return { sent, retried, deadLetter };
    },
    async deleteRemoteRuns(remoteRunIds) {
      if (options.client.deleteRun === undefined) return;
      for (const remoteRunId of remoteRunIds) await options.client.deleteRun(remoteRunId);
    }
  };
}

async function updateExisting(client: LangSmithClient, item: LangSmithOutboxItem): Promise<{ id: string }> {
  await client.updateRun!(item.remoteRunId!, item.event, item.traceId);
  return { id: item.remoteRunId! };
}

function classifyRemoteError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "remote_error";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("rate") || message.includes("429")) return "rate_limit";
  if (message.includes("auth") || message.includes("401") || message.includes("403")) return "authentication";
  return "remote_error";
}
