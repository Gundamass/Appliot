import { ProfileFactSchema, type ProfileFact } from "@resume/contracts";
import {
  EmbeddingSearchUnavailableError,
  type EmbeddingSearchResult,
  type FieldRequest,
  type RagDependencies,
  type RetrievalPlan,
  type RetrievalResult,
  type RetrievedCandidate
} from "./types.js";

const SEARCH_LIMIT = 20;
const EMBEDDING_UNAVAILABLE_REASON = "embedding search unavailable";

export async function retrieveCandidates(
  request: FieldRequest,
  plan: RetrievalPlan,
  dependencies: RagDependencies
): Promise<RetrievalResult> {
  if (!plan.valid) return { candidates: [], invalidReason: plan.invalidReason ?? "invalid retrieval plan" };

  let exact: ProfileFact | undefined;
  try {
    exact = dependencies.repository.resolveForTask(request.taskId, plan.semantic);
  } catch {
    return { candidates: [], invalidReason: "exact repository lookup failed" };
  }

  if (exact !== undefined) {
    const parsed = parseCandidate(exact);
    if (!parsed.success) return { candidates: [], invalidReason: parsed.reason };
    if (parsed.fact.fieldPath !== plan.semantic) {
      return { candidates: [], invalidReason: "exact repository result does not match the requested semantic" };
    }
    if (!isVisibleToTask(parsed.fact, request.taskId)) {
      return { candidates: [], invalidReason: "exact task fact has invalid scope" };
    }
    return { candidates: [{ fact: parsed.fact, source: "exact", score: 1 }] };
  }

  const requiresEmbedding = plan.strategy.includes("embedding");
  const embeddingSearch = dependencies.embeddingSearch;
  if (requiresEmbedding && !embeddingSearch) {
    return { candidates: [], invalidReason: EMBEDDING_UNAVAILABLE_REASON };
  }

  const keyword = await retrieveKeyword(request, plan, dependencies);
  if (keyword.invalidReason) return keyword;

  if (!requiresEmbedding) return finalizeCandidates(keyword.candidates, request.taskId);

  let embeddingResults: EmbeddingSearchResult[];
  try {
    embeddingResults = await embeddingSearch!.search({
      query: embeddingQuery(request, plan),
      taskId: request.taskId,
      limit: SEARCH_LIMIT,
      ...(plan.needsJobDescription && request.jobDescription?.trim()
        ? { jobDescription: request.jobDescription.trim() }
        : {})
    });
  } catch (error) {
    if (error instanceof EmbeddingSearchUnavailableError) {
      return { candidates: [], invalidReason: EMBEDDING_UNAVAILABLE_REASON };
    }
    throw error;
  }

  if (!Array.isArray(embeddingResults)) {
    return { candidates: [], invalidReason: "embedding search returned a malformed response" };
  }

  const embeddings: RetrievedCandidate[] = [];
  for (const result of embeddingResults) {
    if (!result || typeof result !== "object" || !Number.isFinite(result.score) || result.score < -1 || result.score > 1) {
      return { candidates: [], invalidReason: "embedding search returned a malformed response" };
    }
    const parsed = parseCandidate(result.fact);
    if (!parsed.success) return { candidates: [], invalidReason: parsed.reason };
    embeddings.push({ fact: parsed.fact, source: "embedding", score: result.score });
  }

  return finalizeCandidates([...keyword.candidates, ...embeddings], request.taskId);
}

async function retrieveKeyword(
  request: FieldRequest,
  plan: RetrievalPlan,
  dependencies: RagDependencies
): Promise<RetrievalResult> {
  if (!dependencies.search) return { candidates: [] };
  let searchResults: ProfileFact[];
  try {
    searchResults = await dependencies.search.search({
      query: keywordQuery(request, plan),
      semantic: plan.semantic,
      taskId: request.taskId,
      limit: SEARCH_LIMIT,
      ...(plan.needsJobDescription && request.jobDescription?.trim()
        ? { jobDescription: request.jobDescription.trim() }
        : {})
    });
  } catch {
    return { candidates: [], invalidReason: "keyword search failed" };
  }
  if (!Array.isArray(searchResults)) return { candidates: [], invalidReason: "keyword search returned a malformed response" };

  const candidates: RetrievedCandidate[] = [];
  for (const result of searchResults) {
    const parsed = parseCandidate(result);
    if (!parsed.success) return { candidates: [], invalidReason: parsed.reason };
    candidates.push({ fact: parsed.fact, source: "keyword", score: 0 });
  }
  return { candidates };
}

function finalizeCandidates(candidates: RetrievedCandidate[], taskId: string): RetrievalResult {
  const byId = new Map<string, RetrievedCandidate>();
  for (const candidate of candidates) {
    if (candidate.fact.scope === "profile" && candidate.fact.taskId !== undefined) {
      return { candidates: [], invalidReason: "retrieval returned a malformed profile scope" };
    }
    const previous = byId.get(candidate.fact.id);
    if (previous && canonicalJson(previous.fact) !== canonicalJson(candidate.fact)) {
      return { candidates: [], invalidReason: "retrieval returned conflicting duplicate fact IDs" };
    }
    if (!previous || candidate.score > previous.score || (candidate.score === previous.score && candidate.source === "embedding")) {
      byId.set(candidate.fact.id, candidate);
    }
  }
  const visible = [...byId.values()].filter(({ fact }) => isVisibleToTask(fact, taskId) && fact.status !== "superseded");
  return {
    candidates: retainLifecyclePrecedence(visible, taskId)
      .sort((left, right) => right.score - left.score || left.fact.id.localeCompare(right.fact.id))
  };
}

function keywordQuery(request: FieldRequest, plan: RetrievalPlan): string {
  return `${request.label.trim()} ${plan.semantic}`;
}

function embeddingQuery(request: FieldRequest, plan: RetrievalPlan): string {
  const base = keywordQuery(request, plan);
  return plan.needsJobDescription && request.jobDescription?.trim()
    ? `${base}\n${request.jobDescription.trim()}`
    : base;
}

function parseCandidate(candidate: unknown):
  | { success: true; fact: ProfileFact }
  | { success: false; reason: string } {
  const result = ProfileFactSchema.safeParse(candidate);
  return result.success
    ? { success: true, fact: result.data }
    : { success: false, reason: "retrieval returned a malformed profile fact" };
}

function isVisibleToTask(fact: ProfileFact, taskId: string): boolean {
  return fact.scope === "profile" ? fact.taskId === undefined : fact.taskId === taskId;
}

function retainLifecyclePrecedence(candidates: RetrievedCandidate[], taskId: string): RetrievedCandidate[] {
  const bestBySemantic = new Map<string, number>();
  for (const { fact } of candidates) {
    const priority = lifecyclePriority(fact, taskId);
    const current = bestBySemantic.get(fact.fieldPath);
    if (current === undefined || priority < current) bestBySemantic.set(fact.fieldPath, priority);
  }
  return candidates.filter(({ fact }) => lifecyclePriority(fact, taskId) === bestBySemantic.get(fact.fieldPath));
}

function lifecyclePriority(fact: ProfileFact, taskId: string): number {
  if (fact.scope === "application" && fact.taskId === taskId) return 0;
  if (fact.status === "user_corrected") return 1;
  if (fact.status === "user_confirmed") return 2;
  return 3;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
