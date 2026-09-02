import type {
  ConflictJobSelectionInput,
  FilterPlan,
  JobExpectationSnapshot,
  JobMatchResult,
  JobMatchSessionState,
  JobPosting
} from "@resume/contracts";
import { z } from "zod";

export interface JobMatchCursor {
  value: string;
  pagesRead: number;
  elapsedMs: number;
  newJobs: number;
  consecutiveNoNewPages: number;
  continuationToken?: string;
  stopReason?: string;
  updatedAt: string;
}

export interface JobMatchSession {
  id: string;
  version: number;
  state: JobMatchSessionState;
  initialUrl: string;
  scoringVersion: "job-match-v1";
  profileRevision: number;
  expectationRevision: number;
  executionEpoch: number;
  createdAt: string;
  updatedAt: string;
  entryKind?: "job_list" | "job_detail" | "application_form";
  source?: "moka" | "dji" | "baidu";
  adapterVersion?: string;
  selectedResultId?: string;
  selectedPostingContentHash?: string;
  conflictSummaryHash?: string;
  applicationTaskId?: string;
  expectation: JobExpectationSnapshot;
  filterPlan?: FilterPlan;
  postings: JobPosting[];
  results: JobMatchResult[];
  cursor?: JobMatchCursor;
}

export interface JobMatchGuard { sessionVersion: number; idempotencyKey: string }
export type JobSelection = JobMatchGuard & { resultId: string; resultVersion: number; postingContentHash: string };
export type JobConflictSelection = JobSelection & { conflictSummaryHash: string };

export interface JobMatchApi {
  create(url: string): Promise<JobMatchSession | { redirect: "application"; applicationUrl: string }>;
  get(sessionId: string): Promise<JobMatchSession>;
  findOwningConversation(sessionId: string): Promise<{ conversationId: string }>;
  confirmFilters(sessionId: string, expectation: JobExpectationSnapshot, guard: JobMatchGuard): Promise<JobMatchSession>;
  pause(sessionId: string, guard: JobMatchGuard): Promise<JobMatchSession>;
  resume(sessionId: string, guard: JobMatchGuard): Promise<JobMatchSession>;
  continueExtraction(sessionId: string, guard: JobMatchGuard): Promise<JobMatchSession>;
  rematch(sessionId: string, guard: JobMatchGuard): Promise<JobMatchSession>;
  select(sessionId: string, input: JobSelection): Promise<JobMatchSession>;
  selectConflict(sessionId: string, input: JobConflictSelection): Promise<JobMatchSession>;
  convert(sessionId: string, input: JobSelection | JobConflictSelection): Promise<unknown>;
  cancel(sessionId: string, guard: JobMatchGuard): Promise<JobMatchSession>;
}

export class JobMatchApiError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = "JobMatchApiError"; }
}

export function createJobMatchApi(baseUrl = ""): JobMatchApi {
  const path = (id: string) => `${baseUrl}/api/job-match-sessions/${encodeURIComponent(id)}`;
  const guardMutation = (resource: string, id: string, guard: JobMatchGuard) => request<JobMatchSession>(`${path(id)}/${resource}`, post(guard));
  return {
    create: (url) => request(`${baseUrl}/api/job-match-sessions`, post({ url })),
    get: (id) => request<JobMatchSession>(path(id), { method: "GET" }),
    findOwningConversation: async (id) => OwningConversationSchema.parse(await request<unknown>(`${path(id)}/conversation`, { method: "GET" })),
    confirmFilters: (id, expectation, guard) => request<JobMatchSession>(`${path(id)}/filter-confirmation`, json("PUT", { ...guard, expectation })),
    pause: (id, guard) => guardMutation("pause", id, guard),
    resume: (id, guard) => guardMutation("resume", id, guard),
    continueExtraction: (id, guard) => guardMutation("continue-extraction", id, guard),
    rematch: (id, guard) => guardMutation("rematch", id, guard),
    select: (id, input) => request<JobMatchSession>(`${path(id)}/selection`, post(input)),
    selectConflict: (id, input) => request<JobMatchSession>(`${path(id)}/conflict-selection`, post(input)),
    convert: (id, input) => request(`${path(id)}/application`, post(input)),
    cancel: (id, guard) => guardMutation("cancel", id, guard)
  };
}

const OwningConversationSchema = z.object({ conversationId: z.string().min(1).max(256) }).strict();

function post(body: unknown): RequestInit { return json("POST", body); }
function json(method: "POST" | "PUT", body: unknown): RequestInit { return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  let payload: unknown;
  try { payload = response.status === 204 ? undefined : await response.json(); } catch { throw new JobMatchApiError("服务端返回了无法解析的数据"); }
  if (response.ok) return payload as T;
  const record = payload as { error?: unknown; code?: unknown } | null;
  throw new JobMatchApiError(typeof record?.error === "string" ? record.error : `请求失败 (${response.status})`, typeof record?.code === "string" ? record.code : undefined);
}
