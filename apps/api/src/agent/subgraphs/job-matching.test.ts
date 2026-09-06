import { createHash } from "node:crypto";
import type {
  AgentGraphState,
  JobExpectationSnapshot,
  JobMatchResult,
  JobPosting,
  JobRequirement,
  ProfileFact
} from "@resume/contracts";
import { mokaJobAdapter } from "@resume/job-matching";
import { describe, expect, it, vi } from "vitest";
import { createRestrictedToolRegistry, type RestrictedToolRegistry } from "../tool-registry.js";
import type { EvidenceRetrievalPort } from "../../job-matching/lightrag-retrieval-client.js";
import type { JobMatchAggregate, JobMatchRepository } from "../../job-matching/job-match-repository.js";
import type { TraceSink } from "../trace-sink.js";
import { createJobMatchingSubgraph } from "./job-matching.js";

const expectation: JobExpectationSnapshot = {
  revision: 2,
  confirmedAt: "2026-08-21T00:00:00.000Z",
  criteria: []
};

function requirement(
  id: string,
  category: JobRequirement["category"] = "skill",
  normalizedValue = "distributed systems"
): JobRequirement {
  return {
    id,
    category,
    normalizedValue,
    required: true,
    sourceEvidence: `Requirement ${id}`
  };
}

function posting(id: string, requirements: JobRequirement[]): JobPosting {
  return {
    id,
    source: "moka",
    sourceJobId: id,
    canonicalUrl: `https://app.mokahr.com/social-recruitment/example/1#/job/${id}`,
    title: `Role ${id}`,
    organization: "Example",
    description: "Normalized job description only.",
    requirements,
    adapterVersion: "moka-job-v1",
    contentHash: `sha256:${id}`,
    extractedAt: "2026-08-21T00:00:00.000Z"
  };
}

function fact(
  id: string,
  fieldPath: string,
  value: string
): ProfileFact {
  return {
    id,
    fieldPath,
    value,
    status: "user_confirmed",
    confidence: 1,
    scope: "profile",
    evidence: [{
      documentId: "resume-1",
      page: 1,
      text: `Evidence for ${id}: ${value}`,
      extraction: "pdf_text"
    }],
    revision: 3
  };
}

function aggregate(postings: JobPosting[]): JobMatchAggregate {
  return {
    id: "session-1",
    version: 1,
    state: "matching_jobs",
    initialUrl: "https://app.mokahr.com/social-recruitment/example/1#/jobs",
    scoringVersion: "job-match-v1",
    profileRevision: 3,
    expectationRevision: expectation.revision,
    executionEpoch: 1,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    source: "moka",
    adapterVersion: "moka-job-v1",
    expectation,
    postings,
    results: [],
    events: []
  };
}

function graphState(): AgentGraphState {
  return {
    threadId: "thread-1",
    runId: "run-1",
    taskId: "task-1",
    graphVersion: "agent-v1",
    status: "running",
    profileRevision: 3,
    currentSubgraph: "job_matching",
    jobMatching: { sessionId: "session-1" },
    auditEventIds: []
  };
}

function quoteHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createTestGraph(options: {
  postings: JobPosting[];
  facts?: ProfileFact[];
  adapters?: readonly typeof mokaJobAdapter[];
  retrieval?: EvidenceRetrievalPort;
  toolRegistry?: Pick<RestrictedToolRegistry, "invoke">;
  advisor?: ReturnType<typeof vi.fn>;
}) {
  const savedResults: JobMatchResult[][] = [];
  const repository: Pick<JobMatchRepository, "get" | "saveResults"> = {
    get: vi.fn(() => aggregate(options.postings)) as JobMatchRepository["get"],
    saveResults: vi.fn((_sessionId: string, results: JobMatchResult[]) => {
      savedResults.push(results);
    })
  };
  const advisor = { advise: options.advisor ?? vi.fn() };
  const traceSink: TraceSink = {
    record: vi.fn(() => "trace-1"),
    list: vi.fn(() => [])
  };
  const graph = createJobMatchingSubgraph({
    repository,
    profileFacts: { listForTask: vi.fn(() => options.facts ?? []) },
    adapters: options.adapters ?? [mokaJobAdapter],
    ...(options.retrieval === undefined ? {} : { evidenceRetrieval: options.retrieval }),
    ...(options.toolRegistry === undefined ? {} : { toolRegistry: options.toolRegistry }),
    advisor,
    traceSink
  });
  return { graph, advisor, repository, savedResults, traceSink };
}

describe("job matching subgraph", () => {
  it("rejects an unsupported ATS adapter before retrieval or semantic arbitration", async () => {
    const retrieval: EvidenceRetrievalPort = { retrieve: vi.fn() };
    const advisor = vi.fn();
    const { graph } = createTestGraph({
      postings: [posting("posting-1", [requirement("skill-1")])],
      adapters: [],
      retrieval,
      advisor
    });

    const result = await graph({ state: graphState() });

    expect(result).toMatchObject({
      status: "failed",
      currentNode: "select_adapter",
      error: { code: "adapter_contract_mismatch", node: "select_adapter" }
    });
    expect(retrieval.retrieve).not.toHaveBeenCalled();
    expect(advisor).not.toHaveBeenCalled();
  });

  it("limits ranked recommendations to the six highest-ranked results", async () => {
    const scoresByPosting = [30, 90, 50, 80, 10, 60, 70, 40];
    const postings = scoresByPosting.map((_score, postingIndex) => {
      const postingId = `posting-${postingIndex + 1}`;
      return posting(postingId, Array.from({ length: 10 }, (_value, requirementIndex) =>
        requirement(
          `${postingId}-skill-${requirementIndex + 1}`,
          "skill",
          `${postingId}-value-${requirementIndex + 1}`
        )
      ));
    });
    const facts = scoresByPosting.flatMap((score, postingIndex) => {
      const postingId = `posting-${postingIndex + 1}`;
      return Array.from({ length: score / 10 }, (_value, factIndex) =>
        fact(
          `${postingId}-fact-${factIndex + 1}`,
          `skills[${postingIndex * 10 + factIndex}].name`,
          `${postingId}-value-${factIndex + 1}`
        )
      );
    });
    const { graph, savedResults } = createTestGraph({ postings, facts });

    const result = await graph({ state: graphState() });
    const persisted = savedResults[0] ?? [];
    const recommendedIds = result.jobMatching?.recommendedResultIds ?? [];

    expect(recommendedIds).toHaveLength(6);
    expect(new Set(recommendedIds).size).toBe(6);
    expect(recommendedIds.every((id) => persisted.some((item) => item.id === id))).toBe(true);
    expect(recommendedIds.map((id) => persisted.find((item) => item.id === id)?.fitScore))
      .toEqual([90, 80, 70, 60, 50, 40]);
  });

  it("keeps unknown hard constraints rankable and separates confirmed conflicts", async () => {
    const conflict = posting("conflict", [requirement("degree", "education", "Master")]);
    const unknown = posting("unknown", [requirement("rust", "skill", "Rust")]);
    const { graph, savedResults, advisor } = createTestGraph({
      postings: [conflict, unknown],
      facts: [fact("degree-1", "education[0].degree", "Bachelor")]
    });

    const result = await graph({ state: graphState() });

    expect(result).toMatchObject({
      status: "completed",
      currentNode: "rank_and_persist",
      jobMatching: {
        retrievalProvider: "deterministic_fallback",
        fallbackUsed: true
      }
    });
    expect(savedResults).toHaveLength(1);
    expect(savedResults[0]?.find((item) => item.postingId === "conflict")?.outcomes[0]).toMatchObject({
      outcome: "conflict"
    });
    expect(savedResults[0]?.find((item) => item.postingId === "unknown")?.outcomes[0]).toMatchObject({
      outcome: "unknown"
    });
    const conflictEvidence = savedResults[0]?.find((item) => item.postingId === "conflict")?.evidence[0]?.summary;
    expect(conflictEvidence).toContain("学历");
    expect(conflictEvidence).toContain("Bachelor");
    expect(conflictEvidence).not.toMatch(/education\[0\]\.degree|Profile fact/u);
    expect(result.jobMatching?.recommendedResultIds).toHaveLength(1);
    expect(result.jobMatching?.conflictResultIds).toHaveLength(1);
    expect(advisor.advise).not.toHaveBeenCalled();
  });

  it("never allows semantic arbitration to overturn a confirmed hard conflict", async () => {
    const conflict = posting("conflict", [requirement("degree", "education", "Master")]);
    const confirmedDegree = fact("degree-1", "education[0].degree", "Bachelor");
    const retrieval: EvidenceRetrievalPort = {
      retrieve: vi.fn(async () => ({
        provider: "lightrag" as const,
        retrievalVersion: "profile-r3",
        evidence: [{
          evidenceId: confirmedDegree.id,
          documentId: confirmedDegree.evidence[0]!.documentId,
          page: confirmedDegree.evidence[0]!.page,
          quoteHash: quoteHash(confirmedDegree.evidence[0]!.text),
          score: 0.99
        }]
      }))
    };
    const advisor = vi.fn(async () => ({
      outcome: "satisfied",
      confidence: 1,
      evidenceIds: [confirmedDegree.id]
    }));
    const { graph } = createTestGraph({
      postings: [conflict],
      facts: [confirmedDegree],
      retrieval,
      advisor
    });

    const result = await graph({ state: graphState() });

    expect(result.jobMatching?.conflictResultIds).toHaveLength(1);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
    expect(advisor).not.toHaveBeenCalled();
  });

  it("passes only evidence verified against the local fact store to the advisor", async () => {
    const profileEvidence = fact("evidence-1", "skills[0].name", "Kubernetes platform");
    const retrieval: EvidenceRetrievalPort = {
      retrieve: vi.fn(async (input) => input.scope === "job" ? ({
        provider: "lightrag" as const,
        retrievalVersion: "job-r1",
        evidence: [{
          evidenceId: "job-evidence-platform",
          documentId: "job-document-platform",
          postingId: "platform",
          quoteHash: "a".repeat(64),
          score: 0.9
        }]
      }) : ({
        provider: "lightrag" as const,
        retrievalVersion: "profile-r3",
        evidence: [{
          evidenceId: profileEvidence.id,
          documentId: profileEvidence.evidence[0]!.documentId,
          page: profileEvidence.evidence[0]!.page,
          quoteHash: quoteHash(profileEvidence.evidence[0]!.text),
          score: 0.9
        }]
      }))
    };
    const advisor = vi.fn(async () => ({
      outcome: "satisfied",
      confidence: 0.95,
      evidenceIds: [profileEvidence.id]
    }));
    const { graph, savedResults } = createTestGraph({
      postings: [posting("platform", [requirement("containers", "skill", "container orchestration")])],
      facts: [profileEvidence],
      retrieval,
      advisor
    });

    const result = await graph({ state: graphState() });

    expect(result).toMatchObject({
      status: "completed",
      jobMatching: { retrievalProvider: "lightrag", fallbackUsed: false }
    });
    expect(retrieval.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      scope: "profile",
      profileRevision: 3,
      topK: 3
    }));
    expect(retrieval.retrieve).toHaveBeenCalledWith(expect.not.objectContaining({
      scope: "profile",
      postingId: expect.anything()
    }));
    expect(advisor).toHaveBeenCalledWith(expect.objectContaining({
      evidenceIds: [profileEvidence.id],
      evidence: [{
        evidenceId: profileEvidence.id,
        normalizedCategory: profileEvidence.fieldPath,
        normalizedValue: profileEvidence.value
      }]
    }));
    expect(result.jobMatching?.advisories).toEqual([{
      postingId: "platform",
      requirementId: "containers",
      advisory: {
        outcome: "satisfied",
        confidence: 0.95,
        evidenceIds: [profileEvidence.id]
      }
    }]);
    const summary = savedResults[0]?.[0]?.evidence[0]?.summary;
    expect(summary).toContain("技能");
    expect(summary).toContain("Kubernetes platform");
    expect(summary).not.toMatch(/skills\[0\]\.name|Profile fact/u);
  });

  it("retrieves evidence through the graph-only tool registry when it is available", async () => {
    const profileEvidence = fact("evidence-1", "skills[0].name", "Kubernetes platform");
    const retrievalHandler = vi.fn(async (input: unknown) => {
      const request = input as { scope: "profile" | "job" };
      return request.scope === "job" ? {
        provider: "lightrag" as const,
        retrievalVersion: "job-r1",
        evidence: [{
          evidenceId: "job-evidence-platform",
          documentId: "job-document-platform",
          postingId: "platform",
          quoteHash: "a".repeat(64),
          score: 0.9
        }]
      } : {
        provider: "lightrag" as const,
        retrievalVersion: "profile-r3",
        evidence: [{
          evidenceId: profileEvidence.id,
          documentId: profileEvidence.evidence[0]!.documentId,
          page: profileEvidence.evidence[0]!.page,
          quoteHash: quoteHash(profileEvidence.evidence[0]!.text),
          score: 0.9
        }]
      };
    });
    const toolRegistry = createRestrictedToolRegistry({
      retrieve_job_evidence: { allowedCallers: ["graph"], handler: retrievalHandler }
    });
    const directRetrieval: EvidenceRetrievalPort = { retrieve: vi.fn() };
    const { graph } = createTestGraph({
      postings: [posting("platform", [requirement("containers", "skill", "container orchestration")])],
      facts: [profileEvidence],
      retrieval: directRetrieval,
      toolRegistry
    });

    await expect(graph({ state: graphState() })).resolves.toMatchObject({ status: "completed" });

    expect(retrievalHandler).toHaveBeenCalledWith(expect.objectContaining({ scope: "job" }), {
      caller: "graph", runId: "run-1", taskId: "task-1"
    });
    expect(retrievalHandler).toHaveBeenCalledWith(expect.objectContaining({ scope: "profile", profileRevision: 3 }), {
      caller: "graph", runId: "run-1", taskId: "task-1"
    });
    expect(directRetrieval.retrieve).not.toHaveBeenCalled();
  });

  it("does not use accepted model advice to reorder final recommendations", async () => {
    const first = posting("a-first", [requirement("first-skill", "skill", "container orchestration")]);
    const supported = posting("z-supported", [requirement("supported-skill", "skill", "container orchestration")]);
    const advisor = vi.fn(async (input: { requirement: { id: string }; evidenceIds: string[] }) => ({
      outcome: input.requirement.id === "supported-skill" ? "satisfied" : "unknown",
      confidence: 0.95,
      evidenceIds: input.requirement.id === "supported-skill" ? [input.evidenceIds[0]!] : []
    }));
    const { graph, savedResults } = createTestGraph({
      postings: [first, supported],
      facts: [fact("evidence-1", "skills[0].name", "Kubernetes container platform")],
      advisor
    });

    const result = await graph({ state: graphState() });
    const firstResultId = result.jobMatching?.recommendedResultIds?.[0];
    const firstPostingId = savedResults[0]?.find((item) => item.id === firstResultId)?.postingId;

    expect(firstPostingId).toBe("a-first");
    expect(savedResults[0]?.every((item) => item.outcomes[0]?.outcome === "unknown")).toBe(true);
  });

  it("bounds semantic arbitration to the graph-state advisory limit", async () => {
    const requirements = Array.from(
      { length: 101 },
      (_value, index) => requirement(`skill-${index}`, "skill", "container orchestration")
    );
    const advisor = vi.fn(async () => ({
      outcome: "unknown",
      confidence: 0.95,
      evidenceIds: []
    }));
    const { graph } = createTestGraph({
      postings: [posting("bounded", requirements)],
      facts: [fact("evidence-1", "skills[0].name", "Kubernetes container platform")],
      advisor
    });

    const result = await graph({ state: graphState() });

    expect(result.jobMatching?.advisories).toHaveLength(100);
    expect(advisor).toHaveBeenCalledTimes(100);
  });

  it("rejects stale LightRAG evidence and falls back to deterministic retrieval", async () => {
    const profileEvidence = fact("evidence-1", "skills[0].name", "Kubernetes");
    const retrieval: EvidenceRetrievalPort = {
      retrieve: vi.fn(async (input) => input.scope === "job" ? ({
        provider: "lightrag" as const,
        retrievalVersion: "job-r1",
        evidence: [{
          evidenceId: "job-evidence-platform",
          documentId: "job-document-platform",
          postingId: "platform",
          quoteHash: "a".repeat(64),
          score: 0.9
        }]
      }) : ({
        provider: "lightrag" as const,
        retrievalVersion: "profile-r3",
        evidence: [{
          evidenceId: profileEvidence.id,
          documentId: profileEvidence.evidence[0]!.documentId,
          page: profileEvidence.evidence[0]!.page,
          quoteHash: "0".repeat(64),
          score: 0.9
        }]
      }))
    };
    const { graph, savedResults } = createTestGraph({
      postings: [posting("platform", [requirement("kubernetes", "skill", "Kubernetes")])],
      facts: [profileEvidence],
      retrieval
    });

    const result = await graph({ state: graphState() });

    expect(result).toMatchObject({
      status: "completed",
      jobMatching: { retrievalProvider: "deterministic_fallback", fallbackUsed: true }
    });
    expect(savedResults[0]?.[0]?.outcomes[0]).toMatchObject({ outcome: "satisfied" });
  });

  it("falls back when profile evidence carries a job-index identity", async () => {
    const profileEvidence = fact("evidence-1", "skills[0].name", "Kubernetes");
    const retrieval: EvidenceRetrievalPort = {
      retrieve: vi.fn(async (input) => input.scope === "job" ? ({
        provider: "lightrag" as const,
        retrievalVersion: "job-r1",
        evidence: [{
          evidenceId: "job-evidence-platform",
          documentId: "job-document-platform",
          postingId: "platform",
          quoteHash: "a".repeat(64),
          score: 0.9
        }]
      }) : ({
        provider: "lightrag" as const,
        retrievalVersion: "profile-r3",
        evidence: [{
          evidenceId: profileEvidence.id,
          documentId: profileEvidence.evidence[0]!.documentId,
          postingId: "platform",
          page: profileEvidence.evidence[0]!.page,
          quoteHash: quoteHash(profileEvidence.evidence[0]!.text),
          score: 0.9
        }]
      }))
    };
    const { graph } = createTestGraph({
      postings: [posting("platform", [requirement("kubernetes", "skill", "Kubernetes")])],
      facts: [profileEvidence],
      retrieval
    });

    const result = await graph({ state: graphState() });

    expect(result.jobMatching).toMatchObject({
      retrievalProvider: "deterministic_fallback",
      fallbackUsed: true
    });
  });

  it("uses job-index relevance only for discovery, not final recommendation ordering", async () => {
    const profileEvidence = fact("evidence-1", "skills[0].name", "Platform engineering");
    const matched = posting("z-platform", [requirement("platform", "skill", "Platform engineering")]);
    const other = posting("a-other", [requirement("other", "skill", "Platform engineering")]);
    const retrieval: EvidenceRetrievalPort = {
      retrieve: vi.fn(async (input) => input.scope === "job" ? ({
        provider: "lightrag" as const,
        retrievalVersion: "job-r1",
        evidence: [{
          evidenceId: "job-evidence-platform",
          documentId: "opaque-worker-document",
          postingId: matched.id,
          quoteHash: "a".repeat(64),
          score: 0.99
        }]
      }) : ({
        provider: "lightrag" as const,
        retrievalVersion: "profile-r3",
        evidence: [{
          evidenceId: profileEvidence.id,
          documentId: profileEvidence.evidence[0]!.documentId,
          page: profileEvidence.evidence[0]!.page,
          quoteHash: quoteHash(profileEvidence.evidence[0]!.text),
          score: 0.9
        }]
      }))
    };
    const { graph, savedResults } = createTestGraph({
      postings: [matched, other],
      facts: [profileEvidence],
      retrieval
    });

    const result = await graph({ state: graphState() });
    const firstResultId = result.jobMatching?.recommendedResultIds?.[0];
    const firstPostingId = savedResults[0]?.find((item) => item.id === firstResultId)?.postingId;

    expect(retrieval.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      scope: "job",
      query: "skills[0].name: Platform engineering",
      topK: 20
    }));
    expect(retrieval.retrieve).toHaveBeenCalledWith(expect.not.objectContaining({
      scope: "profile",
      postingId: expect.anything()
    }));
    expect(result.jobMatching).toMatchObject({ retrievalProvider: "lightrag", fallbackUsed: false });
    expect(firstPostingId).toBe(other.id);
  });

  it("falls back when a job hit lacks a locally known explicit posting identity", async () => {
    const profileEvidence = fact("evidence-1", "skills[0].name", "Platform engineering");
    const matched = posting("z-platform", [requirement("platform", "skill", "Platform engineering")]);
    const retrieval: EvidenceRetrievalPort = {
      retrieve: vi.fn(async () => ({
        provider: "lightrag" as const,
        retrievalVersion: "job-r1",
        evidence: [{
          evidenceId: "job-evidence-platform",
          documentId: matched.id,
          postingId: "not-a-local-posting",
          quoteHash: "a".repeat(64),
          score: 0.99
        }]
      }))
    };
    const { graph } = createTestGraph({
      postings: [matched],
      facts: [profileEvidence],
      retrieval
    });

    const result = await graph({ state: graphState() });

    expect(result.jobMatching).toMatchObject({
      retrievalProvider: "deterministic_fallback",
      fallbackUsed: true
    });
    expect(retrieval.retrieve).toHaveBeenCalledTimes(1);
  });
});
