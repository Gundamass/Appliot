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

  const parsedResults: ProfileFact[] = [];
  const seen = new Map<string, string>();
  for (const result of searchResults) {
    const parsed = parseCandidate(result);
    if (!parsed.success) return { candidates: [], invalidReason: parsed.reason };
    const payload = canonicalJson(parsed.fact);
    const previous = seen.get(parsed.fact.id);
    if (previous !== undefined && previous !== payload) {
      return { candidates: [], invalidReason: "keyword search returned conflicting duplicate fact IDs" };
    }
    if (previous !== undefined) continue;
    seen.set(parsed.fact.id, payload);
    parsedResults.push(parsed.fact);
  }

  if (parsedResults.some((fact) => fact.scope === "profile" && fact.taskId !== undefined)) {
    return { candidates: [], invalidReason: "keyword search returned a malformed profile scope" };
  }

  const visible = parsedResults.filter((fact) => isVisibleToTask(fact, request.taskId) && fact.status !== "superseded");
  const candidates = retainLifecyclePrecedence(visible, request.taskId)
    .map((fact): RetrievedCandidate => ({ fact, source: "keyword", score: 0 }));

  if (!plan.strategy.includes("embedding") || candidates.length === 0 || !dependencies.embeddingProvider) {
    return { candidates };
  }
  if (candidates.some(({ fact }) => typeof fact.value !== "string")) return { candidates };

  let vectors: number[][];
  try {
    const queryVector = await dependencies.embeddingProvider.embedQuery(embeddingQuery(request, plan));
    const documentVectors = await dependencies.embeddingProvider.embedDocuments(candidates.map(({ fact }) => fact.value as string));
    vectors = [queryVector, ...documentVectors];
  } catch {
    return { candidates: [], invalidReason: "embedding provider failed" };
  }

  const invalidReason = validateEmbeddings(vectors, candidates.length + 1);
  if (invalidReason) return { candidates: [], invalidReason };

  const queryVector = vectors[0]!;
  const scored = candidates
    .map((candidate, index) => ({
      ...candidate,
      score: cosineSimilarity(queryVector, vectors[index + 1]!),
      originalIndex: index
    }));
  if (scored.some(({ score }) => !Number.isFinite(score) || score < -1 || score > 1)) {
    return { candidates: [], invalidReason: "embedding similarity score is invalid" };
  }
  const ranked = scored
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
  return fact.scope === "profile"
    ? fact.taskId === undefined
    : fact.taskId === taskId;
}

function retainLifecyclePrecedence(facts: ProfileFact[], taskId: string): ProfileFact[] {
  const bestBySemantic = new Map<string, number>();
  for (const fact of facts) {
    const priority = lifecyclePriority(fact, taskId);
    const current = bestBySemantic.get(fact.fieldPath);
    if (current === undefined || priority < current) bestBySemantic.set(fact.fieldPath, priority);
  }
  return facts.filter((fact) => lifecyclePriority(fact, taskId) === bestBySemantic.get(fact.fieldPath));
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
  const leftScale = maxAbsolute(left);
  const rightScale = maxAbsolute(right);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]! / leftScale;
    const rightValue = right[index]! / rightScale;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  return Math.max(-1, Math.min(1, dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude))));
}

function maxAbsolute(vector: number[]): number {
  let maximum = 0;
  for (const value of vector) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}
