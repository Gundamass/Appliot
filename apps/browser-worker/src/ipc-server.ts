import { z } from "zod";
import {
  WorkerRequestSchema,
  WorkerActivitySchema,
  WorkerResponseSchema,
  type WorkerActivity,
  type WorkerRequest,
  type WorkerResponse
} from "@resume/contracts";
import { BrowserSessionManager } from "./session-manager.js";

const RequestEnvelopeSchema = z.object({
  requestId: z.string().min(1),
  request: WorkerRequestSchema
}).strict();

const ResponseEnvelopeSchema = z.object({
  requestId: z.string().min(1),
  response: WorkerResponseSchema
}).strict();

const ActivityEnvelopeSchema = z.object({
  response: z.object({
    type: z.literal("activity"),
    activity: WorkerActivitySchema
  }).strict()
}).strict();

interface IpcChannel {
  on(event: "message", listener: (message: unknown) => void): unknown;
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  disconnect(): void;
  stderr: { write(value: string): unknown };
}

function workerError(code: string, error: unknown): WorkerResponse {
  return {
    type: "worker_error",
    code,
    message: error instanceof Error ? error.message : String(error)
  };
}

function send(channel: IpcChannel, requestId: string, response: WorkerResponse): Promise<void> {
  const envelope = ResponseEnvelopeSchema.parse({ requestId, response });
  return new Promise((resolve, reject) => {
    if (!channel.send) {
      reject(new Error("浏览器 Worker 缺少 IPC 通道"));
      return;
    }
    channel.send(envelope, (error: Error | null) => error ? reject(error) : resolve());
  });
}

function sendActivity(channel: IpcChannel, activity: unknown): Promise<void> | undefined {
  const parsedActivity = WorkerActivitySchema.safeParse(activity);
  if (!parsedActivity.success) {
    return undefined;
  }
  const envelope = ActivityEnvelopeSchema.parse({
    response: { type: "activity", activity: parsedActivity.data }
  });
  return new Promise((resolve, reject) => {
    if (!channel.send) {
      reject(new Error("浏览器 Worker 缺少 IPC 通道"));
      return;
    }
    channel.send(envelope, (error: Error | null) => error ? reject(error) : resolve());
  });
}

export function createIpcServer(session: BrowserSessionManager, channel: IpcChannel): void {
  let handshaken = false;
  let queue = Promise.resolve();
  let unsubscribeActivity: (() => void) | undefined;

  const handle = async (request: WorkerRequest): Promise<WorkerResponse> => {
    if (request.type === "handshake") {
      if (handshaken) {
        return workerError("ALREADY_INITIALIZED", "浏览器 Worker 已完成握手");
      }
      await session.start(request.approvalKey);
      handshaken = true;
      unsubscribeActivity = session.subscribeActivity((activity) => {
        void sendActivity(channel, activity)?.catch((error) => {
          channel.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        });
      });
      return { type: "ready" };
    }
    if (!handshaken) {
      return workerError("HANDSHAKE_REQUIRED", "浏览器 Worker 尚未完成握手");
    }
    if (request.type === "open") {
      return session.open(request.taskId, request.url);
    }
    if (request.type === "capture_snapshot") {
      return { type: "snapshot", snapshot: await session.observe(request.taskId) };
    }
    if (request.type === "execute") {
      return session.execute(request.command, request.executionEpoch);
    }
    if (request.type === "invalidate_execution") {
      session.invalidateExecution(request.taskId, request.executionEpoch);
      return { type: "ready" };
    }
    if (request.type === "shutdown") {
      unsubscribeActivity?.();
      unsubscribeActivity = undefined;
      await session.stop();
      return { type: "stopped" };
    }
    return workerError("INVALID_REQUEST", "无法识别的浏览器操作");
  };

  channel.on("message", (rawMessage) => {
    const parsed = RequestEnvelopeSchema.safeParse(rawMessage);
    if (parsed.success && parsed.data.request.type === "invalidate_execution") {
      void (async () => {
        const request = parsed.data.request;
        const response = handshaken
          ? await handle(request)
          : workerError("HANDSHAKE_REQUIRED", "浏览器 Worker 尚未完成握手");
        await send(channel, parsed.data.requestId, response);
      })().catch((error) => channel.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`));
      return;
    }
    queue = queue.then(async () => {
      if (!parsed.success) {
        const requestId = typeof rawMessage === "object" && rawMessage !== null
          && "requestId" in rawMessage && typeof rawMessage.requestId === "string"
          ? rawMessage.requestId
          : "invalid-request";
        await send(channel, requestId, workerError("INVALID_REQUEST", "浏览器 IPC 请求不符合契约"));
        return;
      }

      let response: WorkerResponse;
      try {
        response = await handle(parsed.data.request);
      } catch (error) {
        response = workerError("WORKER_FAILURE", error);
      }
      await send(channel, parsed.data.requestId, response);
      if (parsed.data.request.type === "shutdown") {
        channel.disconnect();
      }
    }).catch(async (error) => {
      channel.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      await session.stop().catch(() => undefined);
      process.exitCode = 1;
      channel.disconnect();
    });
  });
}

export function startIpcServer(session: BrowserSessionManager): void {
  createIpcServer(session, process);
}
