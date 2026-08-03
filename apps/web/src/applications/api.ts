import {
  ApplicationCommandSchema,
  ApplicationTaskInputSchema,
  ApplicationTaskSchema,
  ErrorResponseSchema,
  type ApplicationCommand,
  type ApplicationRecoveryCommand,
  type ApplicationTask,
  type ApplicationTaskInput
} from "@resume/contracts";

export class ApplicationApiError extends Error {
  constructor(message: string, readonly code?: string, readonly taskId?: string) {
    super(message);
    this.name = "ApplicationApiError";
  }
}

export type { ApplicationRecoveryCommand } from "@resume/contracts";

export interface ApplicationApi {
  list(): Promise<ApplicationTask[]>;
  create(input: ApplicationTaskInput): Promise<ApplicationTask>;
  get(taskId: string): Promise<ApplicationTask>;
  delete?(taskId: string): Promise<void>;
  command(taskId: string, command: ApplicationCommand): Promise<ApplicationTask>;
  recover(taskId: string, command: ApplicationRecoveryCommand): Promise<ApplicationTask>;
}

export function createApplicationApi(baseUrl = ""): ApplicationApi {
  const taskPath = (taskId: string) => `${baseUrl}/api/applications/${encodeURIComponent(taskId)}`;
  return {
    async list() {
      return ApplicationTaskSchema.array().parse(await request(`${baseUrl}/api/applications`, { method: "GET" }));
    },

    async create(input) {
      const payload = ApplicationTaskInputSchema.parse(input);
      return ApplicationTaskSchema.parse(await request(`${baseUrl}/api/applications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }));
    },
    async get(taskId) {
      return ApplicationTaskSchema.parse(await request(taskPath(taskId), { method: "GET" }));
    },
    async delete(taskId) {
      await request(taskPath(taskId), { method: "DELETE" });
    },
    async command(taskId, command) {
      const payload = ApplicationCommandSchema.parse(command);
      return ApplicationTaskSchema.parse(await request(`${taskPath(taskId)}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }));
    },
    async recover(taskId, command) {
      return ApplicationTaskSchema.parse(await request(`${taskPath(taskId)}/recovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: command })
      }));
    }
  };
}

async function request(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(response.ok ? "服务器返回了无法解析的数据" : `请求失败 (${response.status})`);
  }
  if (response.ok) return payload;
  const error = ErrorResponseSchema.safeParse(payload);
  throw error.success
    ? new ApplicationApiError(error.data.error, error.data.code, error.data.taskId)
    : new ApplicationApiError(`请求失败 (${response.status})`);
}
