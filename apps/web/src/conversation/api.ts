import {
  ConversationHistoryClearResultSchema,
  ConversationSessionSchema,
  ConversationSessionListSchema,
  ConversationTurnInputSchema,
  ConversationTurnResponseSchema,
  ConversationViewSchema,
  ErrorResponseSchema,
  type ConversationHistoryClearResult,
  type ConversationSession,
  type ConversationTurnResponse,
  type ConversationView
} from "@resume/contracts";

export class ConversationApiError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = "ConversationApiError";
  }
}

export interface ConversationApi {
  list(): Promise<ConversationSession[]>;
  create(): Promise<ConversationSession>;
  get(id: string): Promise<ConversationView>;
  delete(id: string): Promise<void>;
  deleteAll(): Promise<ConversationHistoryClearResult>;
  send(id: string, text: string): Promise<ConversationTurnResponse>;
  confirm(id: string, confirmationId: string, approved: boolean, selectedUrl?: string): Promise<ConversationTurnResponse>;
}

export function createConversationApi(baseUrl = ""): ConversationApi {
  const path = (id: string) => `${baseUrl}/api/conversations/${encodeURIComponent(id)}`;
  return {
    async list() {
      return ConversationSessionListSchema.parse(await request(`${baseUrl}/api/conversations`, {
        method: "GET"
      }));
    },
    async create() {
      return ConversationSessionSchema.parse(await request(`${baseUrl}/api/conversations`, {
        method: "POST"
      }));
    },
    async get(id) {
      return ConversationViewSchema.parse(await request(path(id), { method: "GET" }));
    },
    async delete(id) {
      await request(path(id), { method: "DELETE" });
    },
    async deleteAll() {
      return ConversationHistoryClearResultSchema.parse(await request(`${baseUrl}/api/conversations`, {
        method: "DELETE"
      }));
    },
    async send(id, text) {
      const payload = ConversationTurnInputSchema.safeParse({ text });
      if (!payload.success) throw new ConversationApiError("消息最多 500 字，请缩短后重试", "conversation_input_invalid", 400);
      return ConversationTurnResponseSchema.parse(await request(`${path(id)}/messages`, json("POST", payload.data)));
    },
    async confirm(id, confirmationId, approved, selectedUrl) {
      return ConversationTurnResponseSchema.parse(await request(`${path(id)}/confirm`, json("POST", {
        confirmationId,
        approved,
        ...(selectedUrl === undefined ? {} : { selectedUrl })
      })));
    }
  };
}

function json(method: "POST", body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function request(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ConversationApiError("暂时无法连接对话服务，请稍后重试", "conversation_network_error");
  }
  let payload: unknown;
  try {
    payload = response.status === 204 ? undefined : await response.json();
  } catch {
    throw new ConversationApiError(response.ok ? "服务端返回了无法解析的数据" : "请求失败，请稍后重试", "conversation_response_invalid", response.status);
  }
  if (response.ok) return payload;
  const error = ErrorResponseSchema.safeParse(payload);
  throw error.success
    ? new ConversationApiError(error.data.error, error.data.code, response.status)
    : new ConversationApiError("请求失败，请稍后重试", "conversation_request_failed", response.status);
}
