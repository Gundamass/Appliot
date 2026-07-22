import { ProfileFactSchema, type ProfileFact } from "@resume/contracts";
import type {
  FieldRequest,
  RagDependencies,
  RetrievalPlan,
  RetrievalResult,
  RetrievedCandidate
} from "./types.js";

const SEARCH_LIMIT = 20;

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

  if (!Array.isArray(searchResults)) {
    return { candidates: [], invalidReason: "keyword search returned a malformed response" };
  }

  const candidates: RetrievedCandidate[] = [];
  const seen = new Set<string>();
  for (const result of searchResults) {
    const parsed = parseCandidate(result);
    if (!parsed.success) return { candidates: [], invalidReason: parsed.reason };
    if (!isVisibleToTask(parsed.fact, request.taskId) || parsed.fact.status === "superseded") continue;
    if (seen.has(parsed.fact.id)) continue;
    seen.add(parsed.fact.id);
    candidates.push({ fact: parsed.fact, source: "keyword", score: 0 });
  }

  if (!plan.strategy.includes("embedding") || candidates.length === 0 || !dependencies.modelProvider) {
    return { candidates };
  }
  if (candidates.some(({ fact }) => typeof fact.value !== "string")) return { candidates };

  let vectors: number[][];
  try {
    vectors = await dependencies.modelProvider.embed([
      embeddingQuery(request, plan),
      ...candidates.map(({ fact }) => fact.value as string)
    ]);
  } catch {
    return { candidates: [], invalidReason: "embedding provider failed" };
  }

  const invalidReason = validateEmbeddings(vectors, candidates.length + 1);
  if (invalidReason) return { candidates: [], invalidReason };

  const queryVector = vectors[0]!;
  const ranked = candidates
    .map((candidate, index) => ({
      ...candidate,
      score: cosineSimilarity(queryVector, vectors[index + 1]!),
      originalIndex: index
    }))
    .sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex || left.fact.id.localeCompare(right.fact.id))
    .map(({ originalIndex: _originalIndex, ...candidate }) => candidate);

  return { candidates: ranked };
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
  return fact.scope === "profile" || fact.taskId === taskId;
}

function validateEmbeddings(vectors: unknown, expectedCount: number): string | undefined {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) return "embedding response count mismatch";
  const dimensions = Array.isArray(vectors[0]) ? vectors[0].length : 0;
  if (dimensions === 0) return "embedding vectors must have nonzero dimensions";
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== dimensions) return "embedding vector dimensions mismatch";
    if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      return "embedding vectors must contain finite numbers";
    }
    if (vector.every((value) => value === 0)) return "embedding vectors must have nonzero magnitude";
  }
  return undefined;
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}
