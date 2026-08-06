import { fork, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  WorkerRequestSchema,
  WorkerResponseSchema,
  WorkerActivitySchema,
  type ExecutableCommand,
  type WorkerActivity,
  type WorkerRequest,
  type WorkerResponse
} from "@resume/contracts";

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

interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface BrowserWorkerOptions {
  profileDir: string;
  headless?: boolean;
  executablePath?: string;
  uploadDirectory?: string;
  workerEntry?: string;
  requestTimeoutMs?: number;
  approvalKey?: Uint8Array;
}

function validateWebUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("仅允许 HTTP 或 HTTPS 地址");
  }
}

export class BrowserWorkerClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly activityListeners = new Set<(activity: WorkerActivity) => void>();
  private stopped = false;
  private workerOutput = "";
  private lastTaskId: string | undefined;
  private disconnectNotified = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly requestTimeoutMs: number
  ) {
    child.stderr?.on("data", (chunk) => {
      this.workerOutput += String(chunk);
    });
    child.on("message", (message) => this.handleMessage(message));
    child.on("disconnect", () => this.notifyDisconnected("IPC_DISCONNECTED"));
    child.on("exit", (code, signal) => {
      const detail = this.workerOutput.trim();
      const error = new Error(
        `浏览器 Worker 已退出（code=${String(code)}, signal=${String(signal)}）${detail ? `: ${detail}` : ""}`
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.notifyDisconnected("WORKER_EXITED");
      this.stopped = true;
    });
  }

  static async start(options: BrowserWorkerOptions): Promise<BrowserWorkerClient> {
    const approvalKey = options.approvalKey ?? randomBytes(32);
    if (approvalKey.byteLength < 32) {
      throw new Error("浏览器审批密钥至少需要 32 字节");
    }
    const workerEntry = options.workerEntry
      ?? fileURLToPath(new URL("../../../browser-worker/src/main.ts", import.meta.url));
    const child = fork(workerEntry, [], {
      env: {
        ...process.env,
        RESUME_BROWSER_PROFILE_DIR: options.profileDir,
        RESUME_BROWSER_HEADLESS: String(options.headless ?? false),
        ...(options.executablePath ? { RESUME_BROWSER_EXECUTABLE: options.executablePath } : {}),
        ...(options.uploadDirectory ? { RESUME_BROWSER_UPLOAD_DIR: options.uploadDirectory } : {})
      },
      execArgv: workerEntry.endsWith(".ts") ? ["--import", "tsx"] : [],
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    const client = new BrowserWorkerClient(child, options.requestTimeoutMs ?? 20_000);
    try {
      const response = await client.request({
        type: "handshake",
        approvalKey: Buffer.from(approvalKey).toString("base64url")
      });
      if (response.type !== "ready") {
        throw new Error("浏览器 Worker 未返回 ready");
      }
      return client;
    } catch (error) {
      await client.terminate();
      throw error;
    }
  }

  async open(taskId: string, url: string): Promise<Extract<WorkerResponse, { type: "opened" }>> {
    validateWebUrl(url);
    const response = await this.request({ type: "open", taskId, url });
    if (response.type !== "opened") {
      throw new Error(`浏览器 Worker 返回了意外响应：${response.type}`);
    }
    return response;
  }

  async observe(taskId: string): Promise<Extract<WorkerResponse, { type: "snapshot" }>> {
    const response = await this.request({ type: "capture_snapshot", taskId });
    if (response.type !== "snapshot") {
      throw new Error(`浏览器 Worker 返回了意外响应：${response.type}`);
    }
    return response;
  }

  async execute(command: ExecutableCommand, executionEpoch = 0): Promise<Extract<WorkerResponse, { type: "execution_result" }>> {
    const response = await this.request({ type: "execute", command, executionEpoch });
    if (response.type !== "execution_result") {
      throw new Error(`浏览器 Worker 返回了意外响应：${response.type}`);
    }
    return response;
  }

  async invalidateExecution(taskId: string, executionEpoch: number): Promise<void> {
    await this.request({ type: "invalidate_execution", taskId, executionEpoch });
  }

  async releaseTask(taskId: string): Promise<void> {
    const response = await this.request({ type: "release_task", taskId });
    if (response.type !== "released") {
      throw new Error(`浏览器 Worker 返回了意外响应：${response.type}`);
    }
  }

  onActivity(listener: (activity: WorkerActivity) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const exitPromise = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    try {
      const response = await this.request({ type: "shutdown" });
      if (response.type !== "stopped") {
        throw new Error(`浏览器 Worker 返回了意外响应：${response.type}`);
      }
      await exitPromise;
    } catch {
      await this.terminate();
    }
  }

  private request(rawRequest: WorkerRequest): Promise<WorkerResponse> {
    if (this.stopped || !this.child.connected) {
      return Promise.reject(new Error("浏览器 Worker 未运行"));
    }
    const request = WorkerRequestSchema.parse(rawRequest);
    if (request.type === "open" || request.type === "capture_snapshot") {
      this.lastTaskId = request.taskId;
    } else if (request.type === "execute") {
      this.lastTaskId = request.command.taskId;
    } else if (request.type === "invalidate_execution") {
      this.lastTaskId = request.taskId;
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`浏览器 Worker 请求超时：${request.type}`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.send({ requestId, request }, (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  private handleMessage(rawMessage: unknown): void {
    if (hasRequestBoundActivity(rawMessage)) {
      return;
    }
    const activity = ActivityEnvelopeSchema.safeParse(rawMessage);
    if (activity.success) {
      this.emitActivity(activity.data.response.activity);
      return;
    }
    const parsed = ResponseEnvelopeSchema.safeParse(rawMessage);
    if (!parsed.success) {
      const requestId = typeof rawMessage === "object" && rawMessage !== null
        && "requestId" in rawMessage && typeof rawMessage.requestId === "string"
        ? rawMessage.requestId
        : undefined;
      const pending = requestId ? this.pending.get(requestId) : undefined;
      if (requestId && pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(new Error("浏览器 Worker 响应不符合契约"));
      }
      return;
    }
    const pending = this.pending.get(parsed.data.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(parsed.data.requestId);
    if (parsed.data.response.type === "worker_error") {
      pending.reject(new Error(parsed.data.response.message));
      return;
    }
    pending.resolve(parsed.data.response);
  }

  private emitActivity(activity: WorkerActivity): void {
    for (const listener of this.activityListeners) {
      try {
        listener(activity);
      } catch {
        // Activity listeners are independent observers and must not break IPC handling.
      }
    }
  }

  private notifyDisconnected(code: "WORKER_EXITED" | "IPC_DISCONNECTED"): void {
    if (this.disconnectNotified || !this.lastTaskId) {
      return;
    }
    this.disconnectNotified = true;
    this.emitActivity({ type: "worker_disconnected", taskId: this.lastTaskId, code });
  }

  private async terminate(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const exitPromise = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    if (this.child.connected) {
      this.child.disconnect();
    }
    const forceTimer = setTimeout(() => this.child.kill(), 1_000);
    await exitPromise;
    clearTimeout(forceTimer);
  }
}

function hasRequestBoundActivity(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && "requestId" in value
    && typeof value.requestId === "string"
    && "response" in value
    && typeof value.response === "object" && value.response !== null
    && "type" in value.response
    && value.response.type === "activity";
}
