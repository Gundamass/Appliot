import {
  DocumentResponseSchema,
  ErrorResponseSchema,
  ProfileFactSchema,
  SelfEvaluationDraftSchema,
  SelfEvaluationReviewSchema,
  type SelfEvaluationGeneratedDraft,
  type SelfEvaluationReview,
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

export interface SelfEvaluationReviewApi {
  create(taskId: string, jobDescription: string, draft: SelfEvaluationGeneratedDraft): Promise<SelfEvaluationReview>;
  get(taskId: string): Promise<SelfEvaluationReview>;
  approve(taskId: string, editedDraft?: string, keepOriginal?: boolean): Promise<SelfEvaluationReview>;
  promote(taskId: string): Promise<SelfEvaluationReview>;
}

export function createSelfEvaluationReviewApi(baseUrl = ""): SelfEvaluationReviewApi {
  const path = (taskId: string) => `${baseUrl}/api/reviews/self-evaluations/${encodeURIComponent(taskId)}`;
  const send = async (url: string, init: RequestInit): Promise<SelfEvaluationReview> => SelfEvaluationReviewSchema.parse(await readResponse(await fetch(url, init)));
  return {
    create(taskId, jobDescription, draft) { return send(path(taskId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobDescription, draft }) }); },
    get(taskId) { return send(path(taskId), { method: "GET" }); },
    approve(taskId, editedDraft, keepOriginal) { return send(`${path(taskId)}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(keepOriginal ? { keepOriginal: true } : editedDraft === undefined ? {} : { editedDraft }) }); },
    promote(taskId) { return send(`${path(taskId)}/promote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }); }
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
