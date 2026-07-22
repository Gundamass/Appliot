import {
  DocumentResponseSchema,
  ErrorResponseSchema,
  ProfileFactSchema,
  type ProfileFact
} from "@resume/contracts";
import { z } from "zod";

const ProfileFactListSchema = z.array(ProfileFactSchema);

export interface ProfileApi {
  upload(file: File): Promise<{ documentId: string }>;
  listFacts(): Promise<ProfileFact[]>;
  confirm(factId: string): Promise<ProfileFact>;
  correct(factId: string, value: unknown): Promise<ProfileFact>;
}

export function createProfileApi(baseUrl = ""): ProfileApi {
  return {
    async upload(file) {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`${baseUrl}/api/documents`, { method: "POST", body: form });
      const payload = await readResponse(response);
      const parsed = DocumentResponseSchema.parse(payload);
      return { documentId: parsed.documentId };
    },

    async listFacts() {
      const response = await fetch(`${baseUrl}/api/profile/facts`, { method: "GET" });
      return ProfileFactListSchema.parse(await readResponse(response));
    },

    async confirm(factId) {
      const response = await fetch(`${baseUrl}/api/profile/facts/${encodeURIComponent(factId)}/confirm`, {
        method: "POST"
      });
      return ProfileFactSchema.parse(await readResponse(response));
    },

    async correct(factId, value) {
      const response = await fetch(`${baseUrl}/api/profile/facts/${encodeURIComponent(factId)}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value })
      });
      return ProfileFactSchema.parse(await readResponse(response));
    }
  };
}

async function readResponse(response: Response): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(response.ok ? "服务器返回了无法解析的数据" : `请求失败 (${response.status})`);
  }

  if (response.ok) return payload;

  const error = ErrorResponseSchema.safeParse(payload);
  throw new Error(error.success ? error.data.error : `请求失败 (${response.status})`);
}
