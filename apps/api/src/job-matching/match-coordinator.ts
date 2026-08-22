import { createHash } from "node:crypto";
import type { AgentGraphState, JobMatchResult, JobPosting, ProfileFact } from "@resume/contracts";
import type { JobAdapter, JobRequirementAdvisory } from "@resume/job-matching";
import {
  createJobMatchingSubgraph,
  type JobMatchAdvisor,
  type JobMatchingEmbeddingSearchPort
} from "../agent/subgraphs/job-matching.js";
import type { TraceSink } from "../agent/trace-sink.js";
import type { RestrictedToolRegistry } from "../agent/tool-registry.js";
import { createJobMatchTraceMirror, type JobMatchTraceSink } from "../observability/job-match-trace.js";
import type { EvidenceRetrievalPort } from "./lightrag-retrieval-client.js";
import type { JobMatchAggregate, JobMatchRepository } from "./job-match-repository.js";

export interface MatchCoordinatorDependencies {
  repository: Pick<JobMatchRepository, "get" | "saveResults">;
  profileFacts: { listForTask(taskId: string): ProfileFact[] };
  adapters: readonly JobAdapter[];
  traceSink: TraceSink;
  trace?: JobMatchTraceSink;
  evidenceRetrieval?: EvidenceRetrievalPort;
  toolRegistry?: Pick<RestrictedToolRegistry, "invoke">;
  embeddingSearch?: JobMatchingEmbeddingSearchPort;
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

/**
 * Compatibility facade for the pre-cutover service. All matching decisions
 * are made inside the bounded graph port; this layer only translates its
 * persisted result IDs to the route-facing result shape.
 */
export function createMatchCoordinator(dependencies: MatchCoordinatorDependencies) {
  const subgraph = createJobMatchingSubgraph({
    repository: dependencies.repository,
    profileFacts: dependencies.profileFacts,
    adapters: dependencies.adapters,
    traceSink: createJobMatchTraceMirror(dependencies.traceSink, dependencies.trace),
    ...(dependencies.evidenceRetrieval === undefined ? {} : { evidenceRetrieval: dependencies.evidenceRetrieval }),
    ...(dependencies.toolRegistry === undefined ? {} : { toolRegistry: dependencies.toolRegistry }),
    ...(dependencies.embeddingSearch === undefined ? {} : { embeddingSearch: dependencies.embeddingSearch }),
    ...(dependencies.advisor === undefined ? {} : { advisor: dependencies.advisor })
  });

  return {
    async match(sessionId: string, postings?: readonly JobPosting[]): Promise<MatchCoordinatorOutput> {
      // The persisted ATS-normalized aggregate is the only candidate source.
      void postings;
      const aggregate = dependencies.repository.get(sessionId, { required: true });
      const result = await subgraph({ state: graphState(aggregate) });
      if (result.status !== "completed" || result.jobMatching === undefined) {
        throw new Error(result.error?.code ?? "job_match_graph_failed");
      }

      const refreshed = dependencies.repository.get(sessionId, { required: true });
      const resultById = new Map(refreshed.results.map((item) => [item.id, item]));
      const postingById = new Map(refreshed.postings.map((item) => [item.id, item]));
      return {
        recommended: resolveMatches(result.jobMatching.recommendedResultIds, resultById, postingById),
        conflicts: resolveMatches(result.jobMatching.conflictResultIds, resultById, postingById),
        advisories: (result.jobMatching.advisories ?? []).map(({ requirementId, advisory }) => ({
          requirementId,
          advisory
        })),
        embeddingHealthy: result.jobMatching.embeddingHealthy ?? false
      };
    }
  };
}

function graphState(aggregate: JobMatchAggregate): AgentGraphState {
  const idHash = createHash("sha256").update(aggregate.id).digest("hex");
  return {
    threadId: `job-match-thread-${idHash}`,
    runId: `job-match-run-${idHash}`,
    taskId: aggregate.id,
    graphVersion: "agent-v1",
    status: "running",
    profileRevision: aggregate.profileRevision,
    expectationRevision: aggregate.expectationRevision,
    currentSubgraph: "job_matching",
    jobMatching: { sessionId: aggregate.id },
    auditEventIds: []
  };
}

function resolveMatches(
  resultIds: readonly string[] | undefined,
  resultById: ReadonlyMap<string, JobMatchResult>,
  postingById: ReadonlyMap<string, JobPosting>
): CoordinatedJobMatch[] {
  return (resultIds ?? []).map((resultId) => {
    const result = resultById.get(resultId);
    if (result === undefined) throw new Error("job_match_graph_result_missing");
    const posting = postingById.get(result.postingId);
    if (posting === undefined) throw new Error("job_match_graph_posting_missing");
    return { ...result, canonicalUrl: posting.canonicalUrl };
  });
}
