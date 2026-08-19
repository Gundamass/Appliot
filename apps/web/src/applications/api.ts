import {
  AdapterReviewSummarySchema,
  ApplicationCommandSchema,
  ApplicationTaskInputSchema,
  ApplicationTaskSchema,
  ErrorResponseSchema,
  HintPackDefinitionSchema,
  type ApplicationCommand,
  type ApplicationRecoveryCommand,
  type ApplicationTask,
  type ApplicationTaskInput,
  type AdapterReviewSummary,
  type HintPackDefinition,
  type HumanCertificationDecision
} from "@resume/contracts";
import { z } from "zod";

export class ApplicationApiError extends Error {
  constructor(message: string, readonly code?: string, readonly taskId?: string) {
    super(message);
    this.name = "ApplicationApiError";
  }
}

export type { ApplicationRecoveryCommand } from "@resume/contracts";

export type AdapterDecisionInput = Pick<HumanCertificationDecision, "decision" | "aiReviewUnavailable" | "acknowledgedAiUnavailable"> & {
  notes?: string;
};

export interface AdapterReviewApi {
  get(proposalId: string): Promise<AdapterReviewSummary>;
  replay(proposalId: string): Promise<AdapterReviewSummary>;
  requestAiReview(proposalId: string): Promise<AdapterReviewSummary>;
  revise(proposalId: string, definition: HintPackDefinition): Promise<AdapterReviewSummary>;
  decide(proposalId: string, input: AdapterDecisionInput): Promise<AdapterReviewSummary>;
  retire(packId: string, version: string, reason: string): Promise<void>;
}

export interface ApplicationApi {
  list(): Promise<ApplicationTask[]>;
  create(input: ApplicationTaskInput): Promise<ApplicationTask>;
  get(taskId: string): Promise<ApplicationTask>;
  delete?(taskId: string): Promise<void>;
  command(taskId: string, command: ApplicationCommand): Promise<ApplicationTask>;
  recover(taskId: string, command: ApplicationRecoveryCommand): Promise<ApplicationTask>;
  adapterReview?: AdapterReviewApi;
}

export function createApplicationApi(baseUrl = ""): ApplicationApi {
  const taskPath = (taskId: string) => `${baseUrl}/api/applications/${encodeURIComponent(taskId)}`;
  const proposalPath = (proposalId: string) => `${baseUrl}/api/ats-adapters/proposals/${encodeURIComponent(proposalId)}`;
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
    },
    adapterReview: {
      async get(proposalId) {
        return AdapterReviewSummarySchema.parse(await request(proposalPath(proposalId), { method: "GET" }));
      },
      async replay(proposalId) {
        return AdapterReviewSummarySchema.parse(await request(`${proposalPath(proposalId)}/replay`, { method: "POST" }));
      },
      async requestAiReview(proposalId) {
        return AdapterReviewSummarySchema.parse(await request(`${proposalPath(proposalId)}/ai-review`, { method: "POST" }));
      },
      async revise(proposalId, definition) {
        const payload = HintPackDefinitionSchema.parse(definition);
        return AdapterReviewSummarySchema.parse(await request(`${proposalPath(proposalId)}/revise`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }));
      },
      async decide(proposalId, input) {
        const payload = AdapterDecisionInputSchema.parse(input);
        return AdapterReviewSummarySchema.parse(await request(`${proposalPath(proposalId)}/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }));
      },
      async retire(packId, version, reason) {
        await request(`${baseUrl}/api/ats-adapters/packs/${encodeURIComponent(packId)}/${encodeURIComponent(version)}/retire`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(RetireInputSchema.parse({ reason }))
        });
      }
    }
  };
}

const AdapterDecisionInputSchema = z.object({
  decision: z.enum(["certify", "reject", "revise"]),
  aiReviewUnavailable: z.boolean(),
  acknowledgedAiUnavailable: z.boolean(),
  notes: z.string().max(4000).optional()
}).strict();
const RetireInputSchema = z.object({ reason: z.string().min(1).max(1000) }).strict();

async function request(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (response.ok && (response.status === 204 || response.status === 205)) return undefined;
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
