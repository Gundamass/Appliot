import type {
  JobExpectationSnapshot,
  JobMatchResult,
  JobPosting,
  JobRequirement,
  ProfileFact
} from "@resume/contracts";
import { mokaJobAdapter } from "@resume/job-matching";
import { describe, expect, it, vi } from "vitest";
import type { TraceSink } from "../agent/trace-sink.js";
import { BoundedJobMatchTraceBuffer } from "../observability/job-match-trace.js";
import type { JobMatchAggregate, JobMatchRepository } from "./job-match-repository.js";
import { createMatchCoordinator } from "./match-coordinator.js";

const expectation: JobExpectationSnapshot = {
  revision: 2,
  confirmedAt: "2026-08-16T00:00:00.000Z",
  criteria: [{ kind: "location", values: ["北京"], strength: "required" }]
};

function requirement(
  id: string,
  category: JobRequirement["category"] = "skill",
  normalizedValue = "large scale platform"
): JobRequirement {
  return { id, category, normalizedValue, required: true, sourceEvidence: `requirement ${id}` };
}

function posting(requirements: JobRequirement[], id = "posting-1"): JobPosting {
  return {
    id,
    source: "moka",
    sourceJobId: id,
    canonicalUrl: `https://jobs.example/${id}`,
    title: "Platform Engineer",
    organization: "Example",
    description: "Synthetic description",
    requirements,
    adapterVersion: "moka-job-v1",
    contentHash: `hash-${id}`,
    extractedAt: "2026-08-16T00:00:00.000Z"
  };
}

function fact(id: string, value: string): ProfileFact {
  return {
    id,
    fieldPath: `skills.${id}`,
    value,
    status: "user_confirmed",
    confidence: 1,
    scope: "profile",
    evidence: [{ documentId: "synthetic", page: 1, text: `fact ${id}`, extraction: "pdf_text" }],
    revision: 1
  };
}

function aggregate(postings: JobPosting[]): JobMatchAggregate {
  return {
    id: "session-1",
    version: 3,
    state: "matching_jobs",
    initialUrl: "https://jobs.example",
    scoringVersion: "job-match-v1",
    profileRevision: 7,
    expectationRevision: expectation.revision,
    executionEpoch: 1,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    source: "moka",
    adapterVersion: "moka-job-v1",
    expectation,
    postings,
    results: [],
    events: []
  };
}

function harness(options: {
  postings: JobPosting[];
  facts?: ProfileFact[];
  embeddingSearch?: ReturnType<typeof vi.fn>;
  advise?: ReturnType<typeof vi.fn>;
}) {
  const saveResults = vi.fn();
  let current = aggregate(options.postings);
  const repository: Pick<JobMatchRepository, "get" | "saveResults"> = {
    get: vi.fn(() => current) as JobMatchRepository["get"],
    saveResults: vi.fn((_sessionId: string, results: JobMatchResult[]) => {
      current = { ...current, results };
      saveResults(_sessionId, results);
    })
  };
  const advisor = { advise: options.advise ?? vi.fn() };
  const traceSink: TraceSink = {
    record: vi.fn(() => "trace-1"),
    list: vi.fn(() => [])
  };
  const trace = new BoundedJobMatchTraceBuffer();
  const coordinator = createMatchCoordinator({
    repository,
    profileFacts: { listForTask: vi.fn(() => options.facts ?? []) },
    adapters: [mokaJobAdapter],
    traceSink,
    trace,
    ...(options.embeddingSearch === undefined
      ? {}
      : { embeddingSearch: { search: options.embeddingSearch } }),
    advisor
  });
  return { coordinator, saveResults, advisor, traceSink, trace };
}

describe("MatchCoordinator", () => {
  it("persists deterministic results before bounded advisory calls", async () => {
    const req = requirement("req-1");
    const facts = [fact("e1", "Java backend"), fact("e2", "distributed storage"), fact("e3", "cloud systems")];
    const embeddingSearch = vi.fn().mockResolvedValue(facts.map((item, index) => ({
      fact: item,
      score: 0.9 - index * 0.1
    })));
    let persistedBeforeAdvisory = false;
    const advise = vi.fn().mockImplementation(async () => {
      persistedBeforeAdvisory = harnessValue.saveResults.mock.calls.length === 1;
      return { outcome: "satisfied", confidence: 0.95, evidenceIds: ["e1"] };
    });
    const harnessValue = harness({ postings: [posting([req])], facts, embeddingSearch, advise });

    const output = await harnessValue.coordinator.match("session-1", [posting([req])]);

    expect(persistedBeforeAdvisory).toBe(true);
    expect(harnessValue.saveResults).toHaveBeenCalledTimes(1);
    expect(advise).toHaveBeenCalledWith(expect.objectContaining({
      requirement: expect.objectContaining({ id: "req-1", category: "skill" }),
      evidence: expect.any(Array)
    }));
    expect(advise.mock.calls[0]?.[0].evidence).toHaveLength(3);
    expect(advise.mock.calls[0]?.[0].evidence[0]).not.toHaveProperty("summary");
    expect(output.advisories).toEqual([{
      requirementId: "req-1",
      advisory: { outcome: "satisfied", confidence: 0.95, evidenceIds: ["e1"] }
    }]);
    expect(output.recommended[0]?.outcomes[0]?.outcome).toBe("unknown");
  });

  it("does not call the advisor when embedding infrastructure fails", async () => {
    const req = requirement("java", "skill", "java");
    const embeddingSearch = vi.fn().mockRejectedValue(new Error("offline"));
    const value = harness({
      postings: [posting([req])],
      facts: [fact("java-fact", "java")],
      embeddingSearch
    });

    const output = await value.coordinator.match("session-1", [posting([req])]);

    expect(value.advisor.advise).not.toHaveBeenCalled();
    expect(output.embeddingHealthy).toBe(false);
    expect(output.recommended[0]?.outcomes[0]?.outcome).toBe("satisfied");
    expect(value.saveResults).toHaveBeenCalledTimes(1);
  });

  it("keeps advisory output out of deterministic scores and list membership", async () => {
    const req = requirement("req-1");
    const candidate = fact("e1", "adjacent experience");
    const embeddingSearch = vi.fn().mockResolvedValue([{ fact: candidate, score: 0.9 }]);
    const value = harness({
      postings: [posting([req])],
      facts: [candidate],
      embeddingSearch,
      advise: vi.fn().mockResolvedValue({ outcome: "conflict", confidence: 1, evidenceIds: ["e1"] })
    });

    const output = await value.coordinator.match("session-1", [posting([req])]);
    const persisted = value.saveResults.mock.calls[0]?.[1][0];

    expect(output.conflicts).toEqual([]);
    expect(output.recommended[0]).toMatchObject({
      fitScore: persisted.fitScore,
      confidence: persisted.confidence,
      rankingScore: persisted.rankingScore,
      outcomes: persisted.outcomes
    });
    expect(output.advisories[0]?.advisory.outcome).toBe("unknown");
  });

  it("places only deterministic hard conflicts in the separate conflict list", async () => {
    const conflictPosting = posting([
      requirement("location", "location", "上海"),
      requirement("java", "skill", "java")
    ], "conflict");
    const normalPosting = posting([requirement("unknown")], "normal");
    const value = harness({ postings: [conflictPosting, normalPosting], facts: [] });

    const output = await value.coordinator.match("session-1", [conflictPosting, normalPosting]);

    expect(output.recommended.map((item) => item.postingId)).toEqual(["normal"]);
    expect(output.conflicts.map((item) => item.postingId)).toEqual(["conflict"]);
  });

  it("delegates matching to the graph subgraph and mirrors its audit events", async () => {
    const req = requirement("java", "skill", "java");
    const value = harness({
      postings: [posting([req])],
      facts: [fact("java-fact", "java")]
    });

    const output = await value.coordinator.match("session-1", [posting([req])]);

    expect(output.recommended.map((item) => item.postingId)).toEqual(["posting-1"]);
    expect(value.traceSink.record).toHaveBeenCalledWith(expect.objectContaining({
      node: "rank_and_persist",
      reasonCode: "job_matches_persisted"
    }));
    expect(value.trace.snapshot().map((event) => event.stage)).toContain("rank_and_persist");
  });
});
