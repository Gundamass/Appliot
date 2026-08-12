import {
  DocumentResponseSchema,
  ErrorResponseSchema,
  LatestProfileDocumentResponseSchema,
  ProfileCompletenessSchema,
  ProfileFactSchema,
  ProfileFactUpsertInputSchema,
  RagFieldCorrectionResponseSchema,
  RagFieldInspectionSchema,
  SelfEvaluationDraftSchema,
  SelfEvaluationReviewSchema,
  type RagFieldAnswerBody,
  type RagFieldCorrectionResponse,
  type RagFieldInspection,
  type RagFieldRequest,
  type SelfEvaluationReview,
  type ProfileFact,
  type ProfileCompleteness,
  type ProfileDocumentSummary,
  ProfileFactRemovalInputSchema,
  ProfileFactRemovalResultSchema
} from "@resume/contracts";
import { z } from "zod";

const ProfileFactListSchema = z.array(ProfileFactSchema);

export class ProfileApiError extends Error {
  constructor(message: string, readonly code?: string, readonly statusCode?: number) {
    super(message);
    this.name = "ProfileApiError";
  }
}

export interface ProfileApi {
  upload(file: File): Promise<{ documentId: string }>;
  uploadAvatar(file: File): Promise<{ fileId: string }>;
  listFacts(): Promise<ProfileFact[]>;
  upsert(fieldPath: string, value: unknown): Promise<ProfileFact>;
  remove(fieldPaths: string[]): Promise<void>;
  getCompleteness(): Promise<ProfileCompleteness>;
  getLatestDocument(): Promise<ProfileDocumentSummary | undefined>;
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
    async uploadAvatar(file) {
      const form = new FormData();
      form.append("file", file);
      const payload = await readResponse(await fetch(`${baseUrl}/api/profile/avatar`, { method: "POST", body: form }));
      return z.object({ fileId: z.string().regex(/^avatar-[0-9a-f-]+\.(?:jpg|png|webp)$/u) }).parse(payload);
    },

    async listFacts() {
      const response = await fetch(`${baseUrl}/api/profile/facts`, { method: "GET" });
      return ProfileFactListSchema.parse(await readResponse(response));
    },

    async upsert(fieldPath, value) {
      const payload = ProfileFactUpsertInputSchema.parse({ fieldPath, value });
      const response = await fetch(`${baseUrl}/api/profile/facts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      return ProfileFactSchema.parse(await readResponse(response));
    },

    async remove(fieldPaths) {
      const payload = ProfileFactRemovalInputSchema.parse({ fieldPaths });
      const response = await fetch(`${baseUrl}/api/profile/facts`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      ProfileFactRemovalResultSchema.parse(await readResponse(response));
    },

    async getCompleteness() {
      const response = await fetch(`${baseUrl}/api/profile/completeness`, { method: "GET" });
      return ProfileCompletenessSchema.parse(await readResponse(response));
    },

    async getLatestDocument() {
      const response = await fetch(`${baseUrl}/api/profile/documents/latest`, { method: "GET" });
      return LatestProfileDocumentResponseSchema.parse(await readResponse(response)).document ?? undefined;
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
  create(taskId: string, jobDescription: string): Promise<SelfEvaluationReview>;
  get(taskId: string): Promise<SelfEvaluationReview>;
  approve(taskId: string, editedDraft?: string, keepOriginal?: boolean): Promise<SelfEvaluationReview>;
  promote(taskId: string): Promise<SelfEvaluationReview>;
}

export function createSelfEvaluationReviewApi(baseUrl = ""): SelfEvaluationReviewApi {
  const path = (taskId: string) => `${baseUrl}/api/reviews/self-evaluations/${encodeURIComponent(taskId)}`;
  const send = async (url: string, init: RequestInit): Promise<SelfEvaluationReview> => SelfEvaluationReviewSchema.parse(await readResponse(await fetch(url, init)));
  return {
    create(taskId, jobDescription) { return send(path(taskId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobDescription }) }); },
    get(taskId) { return send(path(taskId), { method: "GET" }); },
    approve(taskId, editedDraft, keepOriginal) { return send(`${path(taskId)}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(keepOriginal ? { keepOriginal: true } : editedDraft === undefined ? {} : { editedDraft }) }); },
    promote(taskId) { return send(`${path(taskId)}/promote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }); }
  };
}

export interface RagApi {
  resolve(request: RagFieldRequest): Promise<RagFieldInspection>;
  answer(answer: RagFieldAnswerBody): Promise<RagFieldCorrectionResponse>;
}

export function createRagApi(baseUrl = ""): RagApi {
  const send = async (path: string, payload: unknown): Promise<unknown> => readResponse(await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
  return {
    async resolve(request) {
      return RagFieldInspectionSchema.parse(await send("/api/rag/fields/resolve", request));
    },
    async answer(answer) {
      return RagFieldCorrectionResponseSchema.parse(await send("/api/rag/fields/answer", answer));
    }
  };
}

async function readResponse(response: Response): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) throw new Error("服务器返回了无法解析的数据");
    throw new ProfileApiError(`请求失败 (${response.status})`, undefined, response.status);
  }

  if (response.ok) return payload;

  const error = ErrorResponseSchema.safeParse(payload);
  throw error.success
    ? new ProfileApiError(error.data.error, error.data.code, response.status)
    : new ProfileApiError(`请求失败 (${response.status})`, undefined, response.status);
}
