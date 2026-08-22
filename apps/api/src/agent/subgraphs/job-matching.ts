import { createHash } from "node:crypto";
import type {
  AgentGraphState,
  JobMatchResult,
  JobMatchingState,
  JobPosting,
  JobRequirement,
  ProfileFact
} from "@resume/contracts";
import {
  UNKNOWN_ADVISORY,
  scoreJobMatch,
  validateAdvisory,
  type JobAdapter,
  type JobRequirementAdvisory,
  type ScoringEvidence
} from "@resume/job-matching";
import type {
  EvidenceRetrievalPort,
  EvidenceRetrievalRequest
} from "../../job-matching/lightrag-retrieval-client.js";
import type { JobMatchAggregate, JobMatchRepository } from "../../job-matching/job-match-repository.js";
import type { SubgraphPort, SubgraphPortInput, SubgraphPortResult } from "../main-graph.js";
import type { TraceSink } from "../trace-sink.js";
import type { RestrictedToolRegistry } from "../tool-registry.js";

const RETRIEVAL_LIMIT = 20;
const ADVISORY_EVIDENCE_LIMIT = 3;
const MAX_ADVISORIES = 100;
const PROFILE_SUMMARY_LIMIT = 2_000;
const HARD_REQUIREMENT_CATEGORIES = new Set<JobRequirement["category"]>([
  "education",
  "major",
  "experience_years"
]);
const HASH = /^[a-f0-9]{64}$/u;

export interface JobMatchingEmbeddingSearchPort {
  search(input: {
    query: string;
    taskId: string;
    limit: number;
    jobDescription?: string;
  }): Promise<Array<{ fact: ProfileFact; score: number }>>;
}

export interface JobMatchAdvisor {
  advise(input: {
    requirement: Pick<JobRequirement, "id" | "category" | "normalizedValue" | "required">;
    evidenceIds: string[];
    evidence: Array<{ evidenceId: string; normalizedCategory: string; normalizedValue: string }>;
  }): Promise<unknown>;
}

export interface JobMatchingSubgraphDependencies {
  repository: Pick<JobMatchRepository, "get" | "saveResults">;
  profileFacts: { listForTask(taskId: string): ProfileFact[] };
  adapters: readonly JobAdapter[];
  evidenceRetrieval?: EvidenceRetrievalPort;
  toolRegistry?: Pick<RestrictedToolRegistry, "invoke">;
  embeddingSearch?: JobMatchingEmbeddingSearchPort;
  advisor?: JobMatchAdvisor;
  traceSink: TraceSink;
}

interface RetrievalCandidate {
  fact: ProfileFact;
  source: "trigram" | "dense";
  score: number;
}

interface PostingPlan {
  posting: JobPosting;
  evidence: ScoringEvidence[];
  advisoryCandidates: Map<string, RetrievalCandidate[]>;
  hardConflict: boolean;
}

interface RetrievalSummary {
  fallbackUsed: boolean;
  lightragUsed: boolean;
  lightragVersion?: string;
  embeddingHealthy: boolean;
  jobDiscoveryScores: Map<string, number>;
}

export function createJobMatchingSubgraph(dependencies: JobMatchingSubgraphDependencies): SubgraphPort {
  return async (input) => matchJobs(dependencies, input);
}

async function matchJobs(
  dependencies: JobMatchingSubgraphDependencies,
  input: SubgraphPortInput
): Promise<SubgraphPortResult> {
  const state = input.state;
  if (state.currentSubgraph !== "job_matching") {
    return failed(undefined, "job_matching_subgraph_mismatch", "observe_ats");
  }
  if (input.resume !== undefined) {
    return failed(state.jobMatching, "job_matching_resume_unsupported", "observe_ats");
  }
  const sessionId = state.jobMatching?.sessionId;
  if (sessionId === undefined) return failed(undefined, "job_matching_session_missing", "observe_ats");

  let aggregate: JobMatchAggregate;
  try {
    aggregate = dependencies.repository.get(sessionId, { required: true });
  } catch {
    return failed({ sessionId }, "job_match_session_not_found", "observe_ats");
  }

  record(dependencies, state, "observe_ats", "node", "completed", "job_postings_observed", {
    candidateIds: aggregate.postings.map((posting) => posting.id),
    counts: { postings: aggregate.postings.length }
  });

  const adapter = selectAdapter(aggregate, dependencies.adapters);
  if (adapter === undefined) {
    record(dependencies, state, "select_adapter", "safety_block", "rejected", "adapter_contract_mismatch", {
      counts: { postings: aggregate.postings.length }
    });
    return failed({ sessionId }, "adapter_contract_mismatch", "select_adapter");
  }
  record(dependencies, state, "select_adapter", "node", "completed", "adapter_selected", {
    counts: { postings: aggregate.postings.length }
  });

  const postings = normalizePostings(aggregate.postings, adapter);
  if (postings === undefined) {
    record(dependencies, state, "normalize_job_spec", "safety_block", "rejected", "adapter_contract_mismatch", {
      counts: { postings: aggregate.postings.length }
    });
    return failed({ sessionId }, "adapter_contract_mismatch", "normalize_job_spec");
  }
  record(dependencies, state, "normalize_job_spec", "node", "completed", "job_specs_normalized", {
    candidateIds: postings.map((posting) => posting.id),
    counts: { postings: postings.length, requirements: postings.reduce((total, posting) => total + posting.requirements.length, 0) }
  });

  const facts = eligibleFacts(dependencies.profileFacts.listForTask(state.taskId));
  const plans = postings.map((posting) => createPostingPlan(aggregate, posting, facts));
  const hardConflicts = plans.filter((plan) => plan.hardConflict);
  record(dependencies, state, "apply_hard_filter", "node", "completed", "hard_conditions_evaluated", {
    candidateIds: hardConflicts.map((plan) => plan.posting.id),
    counts: { postings: plans.length, conflicts: hardConflicts.length, eligibleFacts: facts.length }
  });

  const retrieval = await retrieveEvidence(dependencies, state, aggregate, plans, facts);
  record(dependencies, state, "retrieve_evidence", "tool_call", "completed", retrieval.lightragUsed && !retrieval.fallbackUsed
    ? "lightrag_retrieval"
    : "deterministic_fallback", {
    counts: {
      fallbackUsed: retrieval.fallbackUsed ? 1 : 0,
      lightragUsed: retrieval.lightragUsed ? 1 : 0,
      embeddingHealthy: retrieval.embeddingHealthy ? 1 : 0
    },
    ...(retrieval.lightragVersion === undefined ? {} : { contentHash: hash(retrieval.lightragVersion) })
  });
  record(dependencies, state, "validate_evidence", "node", "completed", "retrieval_evidence_validated", {
    evidenceIds: plans.flatMap((plan) => plan.evidence.map((evidence) => evidence.evidenceId)),
    counts: { evidence: plans.reduce((total, plan) => total + plan.evidence.length, 0) }
  });

  const drafts = plans.map((plan) => score(aggregate, plan));
  const results = drafts.map(toStoredResult);
  dependencies.repository.saveResults(sessionId, results);
  const advisories = await arbitrateUnknowns(dependencies, state, plans, drafts);
  const advisorySupport = advisorySupportByPosting(advisories);
  const ranked = results.map((result, index) => ({
    ...result,
    canonicalUrl: plans[index]!.posting.canonicalUrl,
    hasConflict: drafts[index]!.hasConflict
  }));
  const recommendedResultIds = rankResults(
    ranked.filter((result) => !result.hasConflict),
    retrieval.jobDiscoveryScores,
    advisorySupport
  ).map((result) => result.id);
  const conflictResultIds = rankResults(
    ranked.filter((result) => result.hasConflict),
    retrieval.jobDiscoveryScores,
    advisorySupport
  ).map((result) => result.id);
  const jobMatching = completedState({
    sessionId,
    postings,
    adapter,
    results,
    recommendedResultIds,
    conflictResultIds,
    retrieval,
    advisories
  });
  record(dependencies, state, "rank_and_persist", "node", "completed", "job_matches_persisted", {
    candidateIds: results.map((result) => result.id),
    counts: {
      recommendations: recommendedResultIds.length,
      conflicts: conflictResultIds.length,
      advisorySupported: advisorySupport.size
    }
  });
  return { status: "completed", currentNode: "rank_and_persist", jobMatching };
}

function selectAdapter(aggregate: JobMatchAggregate, adapters: readonly JobAdapter[]): JobAdapter | undefined {
  if (aggregate.source === undefined || aggregate.adapterVersion === undefined) return undefined;
  const adapter = adapters.find((candidate) =>
    candidate.source === aggregate.source && candidate.version === aggregate.adapterVersion
  );
  if (adapter === undefined) return undefined;
  return aggregate.postings.every((posting) =>
    posting.source === adapter.source && posting.adapterVersion === adapter.version
  ) ? adapter : undefined;
}

function normalizePostings(postings: readonly JobPosting[], adapter: JobAdapter): JobPosting[] | undefined {
  const postingIds = new Set<string>();
  for (const posting of postings) {
    if (postingIds.has(posting.id)
      || posting.source !== adapter.source
      || posting.adapterVersion !== adapter.version
      || posting.requirements.some((requirement, index) =>
        requirement.id.length === 0 || posting.requirements.findIndex((item) => item.id === requirement.id) !== index
      )) {
      return undefined;
    }
    postingIds.add(posting.id);
  }
  return [...postings];
}

function createPostingPlan(
  aggregate: JobMatchAggregate,
  posting: JobPosting,
  facts: readonly ProfileFact[]
): PostingPlan {
  const evidence = posting.requirements.flatMap((requirement) => hardConditionEvidence(requirement, facts));
  const draft = scoreJobMatch({
    sessionId: aggregate.id,
    posting,
    expectation: aggregate.expectation,
    profileRevision: aggregate.profileRevision,
    evidence
  });
  return {
    posting,
    evidence,
    advisoryCandidates: new Map<string, RetrievalCandidate[]>(),
    hardConflict: draft.hasConflict
  };
}

async function retrieveEvidence(
  dependencies: JobMatchingSubgraphDependencies,
  state: AgentGraphState,
  aggregate: JobMatchAggregate,
  plans: PostingPlan[],
  facts: readonly ProfileFact[]
): Promise<RetrievalSummary> {
  const summary: RetrievalSummary = {
    fallbackUsed: false,
    lightragUsed: false,
    embeddingHealthy: dependencies.embeddingSearch !== undefined,
    jobDiscoveryScores: new Map<string, number>()
  };

  const discovery = await discoverPostings(dependencies, state, plans, facts);
  if (discovery.provider === "lightrag") {
    summary.lightragUsed = true;
    summary.lightragVersion = discovery.retrievalVersion;
    summary.jobDiscoveryScores = discovery.scores;
  } else {
    summary.fallbackUsed = true;
  }

  for (const plan of plans) {
    if (plan.hardConflict) continue;
    const initial = score(aggregate, plan);
    for (const requirement of plan.posting.requirements) {
      if (HARD_REQUIREMENT_CATEGORIES.has(requirement.category)) continue;
      if (initial.outcomes.find((outcome) => outcome.requirementId === requirement.id)?.outcome !== "unknown") continue;

      const retrieval = await retrievalCandidates(
        dependencies,
        state,
        aggregate,
        plan.posting,
        requirement,
        facts,
        discovery.provider === "lightrag"
      );
      if (retrieval.provider === "lightrag") {
        summary.lightragUsed = true;
        summary.lightragVersion ??= retrieval.retrievalVersion;
      } else {
        summary.fallbackUsed = true;
      }
      if (!retrieval.embeddingHealthy) summary.embeddingHealthy = false;

      const candidates = retrieval.candidates.slice(0, ADVISORY_EVIDENCE_LIMIT);
      plan.advisoryCandidates.set(requirement.id, candidates);
      plan.evidence.push(...candidates.map((candidate) => scoringEvidence(requirement, candidate)));
    }
  }

  return summary;
}

async function retrievalCandidates(
  dependencies: JobMatchingSubgraphDependencies,
  state: AgentGraphState,
  aggregate: JobMatchAggregate,
  posting: JobPosting,
  requirement: JobRequirement,
  facts: readonly ProfileFact[],
  allowLightRag: boolean
): Promise<{
  provider: "lightrag" | "deterministic_fallback";
  retrievalVersion: string;
  candidates: RetrievalCandidate[];
  embeddingHealthy: boolean;
}> {
  if (allowLightRag && canRetrieveEvidence(dependencies)) {
    try {
      const response = await retrieveFromTool(dependencies, state, {
        query: requirement.normalizedValue,
        scope: "profile",
        profileRevision: aggregate.profileRevision,
        topK: ADVISORY_EVIDENCE_LIMIT
      });
      const candidates = validatedLightRagCandidates(response, facts);
      if (candidates !== undefined) {
        return {
          provider: "lightrag",
          retrievalVersion: response.retrievalVersion,
          candidates,
          embeddingHealthy: dependencies.embeddingSearch !== undefined
        };
      }
    } catch {
      // A retrieval error is deliberately indistinguishable from invalid remote evidence to callers.
    }
  }

  const fallback = await deterministicCandidates(dependencies.embeddingSearch, state.taskId, posting, requirement, facts);
  return {
    provider: "deterministic_fallback",
    retrievalVersion: "deterministic-v1",
    candidates: fallback.candidates,
    embeddingHealthy: fallback.embeddingHealthy
  };
}

async function discoverPostings(
  dependencies: JobMatchingSubgraphDependencies,
  state: AgentGraphState,
  plans: readonly PostingPlan[],
  facts: readonly ProfileFact[]
): Promise<{
  provider: "lightrag" | "deterministic_fallback";
  retrievalVersion: string;
  scores: Map<string, number>;
}> {
  const query = boundedProfileSummary(facts);
  if (!canRetrieveEvidence(dependencies) || query === "" || !plans.some((plan) => !plan.hardConflict)) {
    return { provider: "deterministic_fallback", retrievalVersion: "deterministic-v1", scores: new Map() };
  }
  try {
    const response = await retrieveFromTool(dependencies, state, {
      query,
      scope: "job",
      topK: RETRIEVAL_LIMIT
    });
    const scores = validatedJobDiscovery(response, plans);
    if (scores !== undefined) {
      return { provider: "lightrag", retrievalVersion: response.retrievalVersion, scores };
    }
  } catch {
    // Invalid or unavailable job retrieval cannot influence later evidence calls.
  }
  return { provider: "deterministic_fallback", retrievalVersion: "deterministic-v1", scores: new Map() };
}

function canRetrieveEvidence(dependencies: JobMatchingSubgraphDependencies): boolean {
  return dependencies.toolRegistry !== undefined || dependencies.evidenceRetrieval !== undefined;
}

async function retrieveFromTool(
  dependencies: JobMatchingSubgraphDependencies,
  state: AgentGraphState,
  input: EvidenceRetrievalRequest
): Promise<Awaited<ReturnType<EvidenceRetrievalPort["retrieve"]>>> {
  if (dependencies.toolRegistry !== undefined) {
    return await dependencies.toolRegistry.invoke<Awaited<ReturnType<EvidenceRetrievalPort["retrieve"]>>>(
      "retrieve_job_evidence",
      input,
      { caller: "graph", runId: state.runId, taskId: state.taskId }
    );
  }
  if (dependencies.evidenceRetrieval !== undefined) return await dependencies.evidenceRetrieval.retrieve(input);
  throw new Error("job_matching_retrieval_unavailable");
}

function validatedJobDiscovery(
  response: Awaited<ReturnType<EvidenceRetrievalPort["retrieve"]>>,
  plans: readonly PostingPlan[]
): Map<string, number> | undefined {
  if (response.provider !== "lightrag" || response.retrievalVersion.length === 0) return undefined;
  const allowedPostings = new Set(plans.filter((plan) => !plan.hardConflict).map((plan) => plan.posting.id));
  const evidenceIds = new Set<string>();
  const scores = new Map<string, number>();
  for (const reference of response.evidence) {
    if (
      evidenceIds.has(reference.evidenceId)
      || reference.postingId === undefined
      || !allowedPostings.has(reference.postingId)
      || !Number.isFinite(reference.score)
      || reference.score < 0
      || reference.score > 1
      || !HASH.test(reference.quoteHash)
    ) {
      return undefined;
    }
    evidenceIds.add(reference.evidenceId);
    scores.set(reference.postingId, Math.max(scores.get(reference.postingId) ?? 0, reference.score));
  }
  return scores;
}

function validatedLightRagCandidates(
  response: Awaited<ReturnType<EvidenceRetrievalPort["retrieve"]>>,
  facts: readonly ProfileFact[]
): RetrievalCandidate[] | undefined {
  if (response.provider !== "lightrag" || typeof response.retrievalVersion !== "string" || response.retrievalVersion.length === 0) {
    return undefined;
  }
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const candidates: RetrievalCandidate[] = [];
  const seen = new Set<string>();
  for (const reference of response.evidence) {
    if (
      seen.has(reference.evidenceId)
      || !Number.isFinite(reference.score)
      || reference.score < 0
      || reference.score > 1
      || reference.postingId !== undefined
      || reference.page === undefined
      || !HASH.test(reference.quoteHash)
    ) {
      return undefined;
    }
    const fact = byId.get(reference.evidenceId);
    if (fact === undefined || !matchesLocalEvidence(fact, reference.documentId, reference.page, reference.quoteHash)) {
      return undefined;
    }
    seen.add(reference.evidenceId);
    candidates.push({ fact, source: "dense", score: reference.score });
  }
  return candidates.sort(compareCandidates);
}

function matchesLocalEvidence(fact: ProfileFact, documentId: string, page: number, quoteHash: string): boolean {
  return fact.evidence.some((evidence) =>
    evidence.documentId === documentId
    && evidence.page === page
    && createHash("sha256").update(evidence.text).digest("hex") === quoteHash
  );
}

async function deterministicCandidates(
  embeddingSearch: JobMatchingEmbeddingSearchPort | undefined,
  taskId: string,
  posting: JobPosting,
  requirement: JobRequirement,
  facts: readonly ProfileFact[]
): Promise<{ candidates: RetrievalCandidate[]; embeddingHealthy: boolean }> {
  const trigram = trigramCandidates(requirement, facts);
  if (embeddingSearch === undefined) return { candidates: trigram, embeddingHealthy: false };

  try {
    const dense = validateEmbeddingResults(await embeddingSearch.search({
      query: requirement.normalizedValue,
      taskId,
      limit: RETRIEVAL_LIMIT,
      jobDescription: posting.description
    }));
    return { candidates: mergeCandidates(trigram, dense), embeddingHealthy: true };
  } catch {
    return { candidates: trigram, embeddingHealthy: false };
  }
}

async function arbitrateUnknowns(
  dependencies: JobMatchingSubgraphDependencies,
  state: AgentGraphState,
  plans: readonly PostingPlan[],
  drafts: readonly ReturnType<typeof scoreJobMatch>[]
): Promise<Array<{ postingId: string; requirementId: string; advisory: JobRequirementAdvisory }>> {
  if (dependencies.advisor === undefined) return [];
  let requested = 0;
  let accepted = 0;
  let truncated = false;
  const advisories: Array<{ postingId: string; requirementId: string; advisory: JobRequirementAdvisory }> = [];
  outer:
  for (const [postingIndex, plan] of plans.entries()) {
    if (plan.hardConflict || drafts[postingIndex]?.hasConflict) continue;
    for (const requirement of plan.posting.requirements) {
      if (advisories.length >= MAX_ADVISORIES) {
        truncated = true;
        break outer;
      }
      if (HARD_REQUIREMENT_CATEGORIES.has(requirement.category)) continue;
      if (drafts[postingIndex]?.outcomes.find((outcome) => outcome.requirementId === requirement.id)?.outcome !== "unknown") continue;
      const candidates = plan.advisoryCandidates.get(requirement.id) ?? [];
      if (candidates.length === 0) continue;
      requested += 1;
      const evidenceIds = candidates.map((candidate) => candidate.fact.id);
      let advisory: JobRequirementAdvisory = { ...UNKNOWN_ADVISORY };
      try {
        const response = await dependencies.advisor.advise({
          requirement: {
            id: requirement.id,
            category: requirement.category,
            normalizedValue: requirement.normalizedValue,
            required: requirement.required
          },
          evidenceIds,
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
      if (advisory.outcome === "satisfied") accepted += 1;
      advisories.push({ postingId: plan.posting.id, requirementId: requirement.id, advisory });
      record(dependencies, state, "arbitrate_unknowns", "model_decision", advisory.outcome === "satisfied" ? "accepted" : "unknown", "evidence_constrained_advisory", {
        confidence: advisory.confidence,
        candidateIds: [requirement.id],
        evidenceIds: advisory.evidenceIds,
        counts: { requested: 1, accepted: advisory.outcome === "satisfied" ? 1 : 0 }
      });
    }
  }
  if (requested === 0) {
    record(dependencies, state, "arbitrate_unknowns", "node", "completed", "no_eligible_unknowns", {
      counts: { requested, accepted }
    });
  } else if (truncated) {
    record(dependencies, state, "arbitrate_unknowns", "node", "completed", "advisory_limit_reached", {
      counts: { requested, accepted, truncated: 1 }
    });
  }
  return advisories;
}

function hardConditionEvidence(requirement: JobRequirement, facts: readonly ProfileFact[]): ScoringEvidence[] {
  if (!requirement.required || !HARD_REQUIREMENT_CATEGORIES.has(requirement.category)) return [];
  const compared = facts
    .filter((fact) => isFactForHardRequirement(fact, requirement.category))
    .map((fact) => ({ fact, relation: compareHardRequirement(requirement, fact) }))
    .filter((candidate): candidate is { fact: ProfileFact; relation: "supports" | "contradicts" } => candidate.relation !== undefined)
    .sort((left, right) => compareText(left.fact.id, right.fact.id));
  const support = compared.find((candidate) => candidate.relation === "supports");
  if (support !== undefined) return [confirmedEvidence(requirement, support.fact, "supports")];
  const conflict = compared.find((candidate) => candidate.relation === "contradicts");
  return conflict === undefined ? [] : [confirmedEvidence(requirement, conflict.fact, "contradicts")];
}

function isFactForHardRequirement(fact: ProfileFact, category: JobRequirement["category"]): boolean {
  const path = fact.fieldPath.toLocaleLowerCase("en-US");
  if (category === "education") return path.includes("education") || path.includes("degree") || path.includes("学历");
  if (category === "major") return path.includes("major") || path.includes("专业");
  return path.includes("experience") || path.includes("employment") || path.includes("work") || path.includes("year");
}

function compareHardRequirement(
  requirement: JobRequirement,
  fact: ProfileFact
): "supports" | "contradicts" | undefined {
  if (requirement.category === "education") {
    const requiredRank = degreeRank(requirement.normalizedValue);
    const factRank = degreeRank(factValue(fact));
    if (requiredRank === undefined || factRank === undefined) return undefined;
    return factRank >= requiredRank ? "supports" : "contradicts";
  }
  if (requirement.category === "experience_years") {
    const requiredYears = years(requirement.normalizedValue);
    const factYears = years(factValue(fact));
    if (requiredYears === undefined || factYears === undefined) return undefined;
    return factYears >= requiredYears ? "supports" : "contradicts";
  }
  const expected = comparableValue(requirement.normalizedValue);
  const actual = comparableValue(factValue(fact));
  if (expected === "" || actual === "") return undefined;
  return actual === expected ? "supports" : "contradicts";
}

function confirmedEvidence(
  requirement: JobRequirement,
  fact: ProfileFact,
  relation: "supports" | "contradicts"
): ScoringEvidence {
  return {
    requirementId: requirement.id,
    evidenceId: fact.id,
    source: "confirmed_fact",
    relation,
    summary: `Profile fact ${fact.fieldPath}`
  };
}

function degreeRank(value: string): number | undefined {
  const normalized = comparableValue(value);
  if (/博士|phd|doctor/u.test(normalized)) return 4;
  if (/硕士|master/u.test(normalized)) return 3;
  if (/本科|学士|bachelor/u.test(normalized)) return 2;
  if (/大专|associate|diploma/u.test(normalized)) return 1;
  return undefined;
}

function years(value: string): number | undefined {
  const matched = value.normalize("NFKC").match(/\d+(?:\.\d+)?/u)?.[0];
  if (matched === undefined) return undefined;
  const parsed = Number(matched);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
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
  return [...byId.values()].sort(compareCandidates).slice(0, RETRIEVAL_LIMIT);
}

function scoringEvidence(requirement: JobRequirement, candidate: RetrievalCandidate): ScoringEvidence {
  const exact = comparableValue(requirement.normalizedValue) === comparableValue(factValue(candidate.fact));
  return {
    requirementId: requirement.id,
    evidenceId: candidate.fact.id,
    source: exact ? "confirmed_fact" : candidate.source,
    relation: exact ? "supports" : "related",
    summary: `Profile fact ${candidate.fact.fieldPath}`
  };
}

function score(aggregate: JobMatchAggregate, plan: PostingPlan): ReturnType<typeof scoreJobMatch> {
  return scoreJobMatch({
    sessionId: aggregate.id,
    posting: plan.posting,
    expectation: aggregate.expectation,
    profileRevision: aggregate.profileRevision,
    evidence: plan.evidence
  });
}

function rankResults<
  T extends {
    postingId: string;
    canonicalUrl: string;
    rankingScore: number;
    fitScore: number;
    confidence: number;
  }
>(
  results: readonly T[],
  discoveryScores: ReadonlyMap<string, number>,
  advisorySupport: ReadonlyMap<string, number>
): T[] {
  return [...results].sort((left, right) =>
    right.rankingScore - left.rankingScore
    || right.fitScore - left.fitScore
    || right.confidence - left.confidence
    || (discoveryScores.get(right.postingId) ?? 0) - (discoveryScores.get(left.postingId) ?? 0)
    || (advisorySupport.get(right.postingId) ?? 0) - (advisorySupport.get(left.postingId) ?? 0)
    || compareText(left.canonicalUrl, right.canonicalUrl)
  );
}

function advisorySupportByPosting(
  advisories: ReadonlyArray<{ postingId: string; advisory: JobRequirementAdvisory }>
): Map<string, number> {
  const support = new Map<string, number>();
  for (const { postingId, advisory } of advisories) {
    if (advisory.outcome === "satisfied") support.set(postingId, (support.get(postingId) ?? 0) + 1);
  }
  return support;
}

function toStoredResult(draft: ReturnType<typeof scoreJobMatch>): JobMatchResult {
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
    id: `jmr_${hash(identity)}`,
    version: 0,
    stale: false,
    ...value
  };
}

function completedState(input: {
  sessionId: string;
  postings: readonly JobPosting[];
  adapter: JobAdapter;
  results: readonly JobMatchResult[];
  recommendedResultIds: string[];
  conflictResultIds: string[];
  retrieval: RetrievalSummary;
  advisories: Array<{ postingId: string; requirementId: string; advisory: JobRequirementAdvisory }>;
}): JobMatchingState {
  const useLightRag = input.retrieval.lightragUsed && !input.retrieval.fallbackUsed;
  return {
    sessionId: input.sessionId,
    postingIds: input.postings.map((posting) => posting.id),
    recommendedResultIds: input.recommendedResultIds,
    conflictResultIds: input.conflictResultIds,
    adapterVersion: input.adapter.version,
    scoringVersion: "job-match-v1",
    retrievalProvider: useLightRag ? "lightrag" : "deterministic_fallback",
    retrievalVersion: useLightRag ? input.retrieval.lightragVersion : "deterministic-v1",
    retrievalHealthy: useLightRag,
    fallbackUsed: input.retrieval.fallbackUsed,
    embeddingHealthy: input.retrieval.embeddingHealthy,
    advisories: input.advisories
  };
}

function failed(
  jobMatching: JobMatchingState | undefined,
  code: string,
  currentNode: string
): SubgraphPortResult {
  return {
    status: "failed",
    currentNode,
    error: { code, retryable: false, node: currentNode },
    ...(jobMatching === undefined ? {} : { jobMatching })
  };
}

function record(
  dependencies: JobMatchingSubgraphDependencies,
  state: AgentGraphState,
  node: string,
  kind: "node" | "tool_call" | "model_decision" | "safety_block",
  outcome: string,
  reasonCode: string,
  extra: {
    confidence?: number;
    candidateIds?: string[];
    evidenceIds?: string[];
    counts?: Record<string, number>;
    contentHash?: string;
  }
): void {
  dependencies.traceSink.record({
    runId: state.runId,
    taskId: state.taskId,
    node,
    kind,
    outcome,
    reasonCode,
    ...(extra.confidence === undefined ? {} : { confidence: extra.confidence }),
    ...(extra.candidateIds === undefined ? {} : { candidateIds: uniqueIds(extra.candidateIds).slice(0, 100) }),
    ...(extra.evidenceIds === undefined ? {} : { evidenceIds: uniqueIds(extra.evidenceIds).slice(0, 100) }),
    ...(extra.counts === undefined ? {} : { counts: extra.counts }),
    ...(extra.contentHash === undefined ? {} : { contentHash: extra.contentHash })
  });
}

function factValue(fact: ProfileFact): string {
  if (typeof fact.value === "string") return fact.value.slice(0, 500);
  return JSON.stringify(fact.value).slice(0, 500);
}

function boundedProfileSummary(facts: readonly ProfileFact[]): string {
  const summary: string[] = [];
  let length = 0;
  for (const fact of facts) {
    if (!isMatchRelevantField(fact.fieldPath)) continue;
    const value = factValue(fact).replace(/\s+/gu, " ").trim();
    if (value === "") continue;
    const item = `${fact.fieldPath}: ${value.slice(0, 240)}`;
    const separatorLength = summary.length === 0 ? 0 : 3;
    const remaining = PROFILE_SUMMARY_LIMIT - length - separatorLength;
    if (remaining <= 0) break;
    summary.push(item.slice(0, remaining));
    length += separatorLength + item.slice(0, remaining).length;
    if (item.length > remaining) break;
  }
  return summary.join(" | ");
}

function isMatchRelevantField(fieldPath: string): boolean {
  const normalized = fieldPath.toLocaleLowerCase("en-US");
  if (/(email|phone|mobile|telephone|address|identity|passport|contact)/u.test(normalized)) return false;
  return /(skill|technology|education|degree|major|experience|employment|project|responsibilit|industry|location|work_mode|employment_type)/u.test(normalized);
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, "");
}

function comparableValue(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
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

function compareCandidates(left: RetrievalCandidate, right: RetrievalCandidate): number {
  return right.score - left.score || compareText(left.fact.id, right.fact.id);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
