import { createHash } from "node:crypto";
import type { JobMatchResult, JobPosting, JobRequirement, ProfileFact } from "@resume/contracts";
import {
  UNKNOWN_ADVISORY,
  scoreJobMatch,
  sortJobMatches,
  validateAdvisory,
  type JobRequirementAdvisory,
  type ScoringEvidence
} from "@resume/job-matching";
import type { JobMatchRepository } from "./job-match-repository.js";

const RETRIEVAL_LIMIT = 20;
const ADVISORY_EVIDENCE_LIMIT = 3;

interface EmbeddingSearchPort {
  search(input: {
    query: string;
    taskId: string;
    limit: number;
    jobDescription?: string;
  }): Promise<Array<{ fact: ProfileFact; score: number }>>;
}

interface JobMatchAdvisor {
  advise(input: {
    requirement: Pick<JobRequirement, "id" | "category" | "normalizedValue" | "required">;
    evidence: Array<{ evidenceId: string; normalizedCategory: string; normalizedValue: string }>;
  }): Promise<unknown>;
}

interface MatchCoordinatorDependencies {
  repository: Pick<JobMatchRepository, "get" | "saveResults">;
  profileFacts: { listForTask(taskId: string): ProfileFact[] };
  embeddingSearch?: EmbeddingSearchPort;
  advisor?: JobMatchAdvisor;
}

export interface CoordinatedJobMatch extends JobMatchResult {
  canonicalUrl: string;
}

export interface MatchCoordinatorOutput {
  recommended: CoordinatedJobMatch[];
  conflicts: CoordinatedJobMatch[];
  advisories: Array<{ requirementId: string; advisory: JobRequirementAdvisory }>;
  embeddingHealthy: boolean;
}

interface RetrievalCandidate {
  fact: ProfileFact;
  source: "trigram" | "dense";
  score: number;
}

interface PostingRetrieval {
  posting: JobPosting;
  evidence: ScoringEvidence[];
  advisoryCandidates: Map<string, RetrievalCandidate[]>;
}

export function createMatchCoordinator(dependencies: MatchCoordinatorDependencies) {
  return {
    async match(sessionId: string, postings: readonly JobPosting[]): Promise<MatchCoordinatorOutput> {
      const aggregate = dependencies.repository.get(sessionId, { required: true });
      const facts = eligibleFacts(dependencies.profileFacts.listForTask(sessionId));
      let embeddingHealthy = dependencies.embeddingSearch !== undefined;
      const retrievals: PostingRetrieval[] = [];

      for (const posting of postings) {
        const evidence: ScoringEvidence[] = [];
        const advisoryCandidates = new Map<string, RetrievalCandidate[]>();
        for (const requirement of posting.requirements) {
          const trigram = trigramCandidates(requirement, facts);
          let dense: RetrievalCandidate[] = [];
          if (dependencies.embeddingSearch !== undefined) {
            try {
              dense = validateEmbeddingResults(await dependencies.embeddingSearch.search({
                query: requirement.normalizedValue,
                taskId: sessionId,
                limit: RETRIEVAL_LIMIT,
                jobDescription: posting.description
              }));
            } catch {
              embeddingHealthy = false;
            }
          }
          const candidates = mergeCandidates(trigram, dense).slice(0, ADVISORY_EVIDENCE_LIMIT);
          advisoryCandidates.set(requirement.id, candidates);
          evidence.push(...candidates.map((candidate) => scoringEvidence(requirement, candidate)));
        }
        retrievals.push({ posting, evidence, advisoryCandidates });
      }

      const scored = retrievals.map(({ posting, evidence }) => scoreJobMatch({
        sessionId,
        posting,
        expectation: aggregate.expectation,
        profileRevision: aggregate.profileRevision,
        evidence
      }));
      const fullResults = scored.map(toStoredResult);
      dependencies.repository.saveResults(sessionId, fullResults);

      const advisories: MatchCoordinatorOutput["advisories"] = [];
      if (embeddingHealthy && dependencies.advisor !== undefined) {
        for (const [postingIndex, retrieval] of retrievals.entries()) {
          const outcomes = scored[postingIndex]?.outcomes ?? [];
          for (const requirement of retrieval.posting.requirements) {
            if (outcomes.find((item) => item.requirementId === requirement.id)?.outcome !== "unknown") continue;
            const candidates = retrieval.advisoryCandidates.get(requirement.id) ?? [];
            if (candidates.length === 0) continue;
            const evidenceIds = candidates.map((item) => item.fact.id);
            let advisory = UNKNOWN_ADVISORY;
            try {
              const response = await dependencies.advisor.advise({
                requirement: {
                  id: requirement.id,
                  category: requirement.category,
                  normalizedValue: requirement.normalizedValue,
                  required: requirement.required
                },
                evidence: candidates.map((candidate) => ({
                  evidenceId: candidate.fact.id,
                  normalizedCategory: candidate.fact.fieldPath,
                  normalizedValue: factValue(candidate.fact)
                }))
              });
              advisory = validateAdvisory(requirement, evidenceIds, response);
            } catch {
              advisory = { ...UNKNOWN_ADVISORY };
            }
            advisories.push({ requirementId: requirement.id, advisory });
          }
        }
      }

      const enriched = fullResults.map((result, index) => ({
        ...result,
        canonicalUrl: postings[index]?.canonicalUrl ?? ""
      }));
      return {
        recommended: sortJobMatches(enriched.filter((_result, index) => !scored[index]?.hasConflict)),
        conflicts: sortJobMatches(enriched.filter((_result, index) => scored[index]?.hasConflict)),
        advisories,
        embeddingHealthy
      };
    }
  };
}

function eligibleFacts(facts: readonly ProfileFact[]): ProfileFact[] {
  return facts
    .filter((fact) => fact.scope === "profile"
      && fact.taskId === undefined
      && (fact.status === "user_confirmed" || fact.status === "user_corrected"))
    .sort((left, right) => compareText(left.id, right.id));
}

function trigramCandidates(requirement: JobRequirement, facts: readonly ProfileFact[]): RetrievalCandidate[] {
  const query = normalizeText(requirement.normalizedValue);
  return facts.flatMap((fact) => {
    const score = trigramSimilarity(query, normalizeText(`${fact.fieldPath} ${factValue(fact)}`));
    return score === 0 ? [] : [{ fact, source: "trigram" as const, score }];
  }).sort(compareCandidates).slice(0, RETRIEVAL_LIMIT);
}

function validateEmbeddingResults(results: Array<{ fact: ProfileFact; score: number }>): RetrievalCandidate[] {
  if (!Array.isArray(results)) throw new Error("job_match_embedding_malformed");
  return results.map((result) => {
    if (!result || !Number.isFinite(result.score) || result.score < -1 || result.score > 1) {
      throw new Error("job_match_embedding_malformed");
    }
    return { fact: result.fact, source: "dense" as const, score: result.score };
  }).filter((candidate) => eligibleFacts([candidate.fact]).length === 1)
    .sort(compareCandidates)
    .slice(0, RETRIEVAL_LIMIT);
}

function mergeCandidates(...groups: RetrievalCandidate[][]): RetrievalCandidate[] {
  const byId = new Map<string, RetrievalCandidate>();
  for (const candidate of groups.flat()) {
    const current = byId.get(candidate.fact.id);
    if (current === undefined
      || candidate.score > current.score
      || (candidate.score === current.score && candidate.source === "trigram")) {
      byId.set(candidate.fact.id, candidate);
    }
  }
  return [...byId.values()].sort(compareCandidates);
}

function scoringEvidence(requirement: JobRequirement, candidate: RetrievalCandidate): ScoringEvidence {
  const exact = normalizeText(requirement.normalizedValue) === normalizeText(factValue(candidate.fact));
  return {
    requirementId: requirement.id,
    evidenceId: candidate.fact.id,
    source: exact ? "confirmed_fact" : candidate.source,
    relation: exact ? "supports" : "related",
    summary: `Profile fact ${candidate.fact.fieldPath}`
  };
}

function toStoredResult(
  draft: ReturnType<typeof scoreJobMatch>
): JobMatchResult {
  const { canonicalUrl: _canonicalUrl, hasConflict: _hasConflict, ...value } = draft;
  const identity = [
    value.sessionId,
    value.postingId,
    value.scoringVersion,
    value.profileRevision,
    value.expectationRevision,
    value.postingContentHash
  ].join("\u0000");
  return {
    id: `jmr_${createHash("sha256").update(identity).digest("hex")}`,
    version: 0,
    stale: false,
    ...value
  };
}

function factValue(fact: ProfileFact): string {
  if (typeof fact.value === "string") return fact.value.slice(0, 500);
  return JSON.stringify(fact.value).slice(0, 500);
}

function trigramSimilarity(left: string, right: string): number {
  if (left === "" || right === "") return 0;
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  let overlap = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) overlap += 1;
  return overlap === 0 ? 0 : (2 * overlap) / (leftGrams.size + rightGrams.size);
}

function grams(value: string): Set<string> {
  if (value.length <= 3) return new Set([value]);
  const result = new Set<string>();
  for (let index = 0; index <= value.length - 3; index += 1) result.add(value.slice(index, index + 3));
  return result;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, "");
}

function compareCandidates(left: RetrievalCandidate, right: RetrievalCandidate): number {
  return right.score - left.score || compareText(left.fact.id, right.fact.id);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
