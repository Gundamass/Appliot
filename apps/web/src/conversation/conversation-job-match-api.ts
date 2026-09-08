import {
  ConversationJobMatchActionResultSchema,
  ConversationJobMatchActionSchema,
  type ConversationJobMatchAction,
  type ConversationJobMatchActionResult
} from "@resume/contracts";

export interface ConversationJobMatchApi {
  execute(input: ConversationJobMatchAction): Promise<ConversationJobMatchActionResult>;
}

export class ConversationJobMatchApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly statusCode?: number
  ) {
    super(message);
    this.name = "ConversationJobMatchApiError";
  }
}

export function createConversationJobMatchApi(baseUrl = ""): ConversationJobMatchApi {
  const root = baseUrl.replace(/\/+$/u, "");
  return {
    async execute(rawInput) {
      const input = ConversationJobMatchActionSchema.parse(rawInput);
      const response = await fetch(`${root}/api/conversations/${encodeURIComponent(input.conversationId)}/job-match-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      });
      const payload = await readPayload(response);
      if (!response.ok) {
        const record = asErrorPayload(payload);
        throw new ConversationJobMatchApiError(
          record.error ?? `请求失败 (${response.status})`,
          record.code,
          response.status
        );
      }
      const parsed = ConversationJobMatchActionResultSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ConversationJobMatchApiError(
          "服务端返回的岗位匹配结果格式无效",
          "conversation_job_match_response_invalid",
          response.status
        );
      }
      return parsed.data;
    }
  };
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return response.status === 204 ? undefined : await response.json();
  } catch {
    throw new ConversationJobMatchApiError(
      "服务器返回了无法解析的数据",
      "conversation_job_match_response_invalid",
      response.status
    );
  }
}

function asErrorPayload(value: unknown): { error?: string; code?: string } {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(typeof record.code === "string" ? { code: record.code } : {})
  };
}
