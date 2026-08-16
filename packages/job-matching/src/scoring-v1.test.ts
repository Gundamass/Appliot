import type {
  JobExpectationSnapshot,
  JobPosting,
  JobRequirement
} from "@resume/contracts";
import { describe, expect, it } from "vitest";
import {
  assessRequirement,
  scoreJobMatch,
  sortJobMatches,
  type ScoringEvidence
} from "./scoring-v1.js";

const expectation: JobExpectationSnapshot = {
  revision: 4,
  confirmedAt: "2026-08-16T00:00:00.000Z",
  criteria: [
    { kind: "location", values: ["北京"], strength: "required" },
    { kind: "employment_type", values: ["全职"], strength: "required" },
    { kind: "industry", values: ["软件"], strength: "required" },
    { kind: "work_mode", values: ["远程"], strength: "required" }
  ]
};

function requirement(
  id: string,
  category: JobRequirement["category"],
  required = true,
  normalizedValue = id
): JobRequirement {
  return { id, category, normalizedValue, required, sourceEvidence: `requirement ${id}` };
}

function evidence(
  requirementId: string,
  source: ScoringEvidence["source"],
  relation: ScoringEvidence["relation"] = "supports"
): ScoringEvidence {
  return {
    requirementId,
    evidenceId: `e-${requirementId}`,
    source,
    relation,
    summary: `evidence ${requirementId}`
  };
}

function posting(requirements: JobRequirement[], canonicalUrl = "https://jobs.example/a"): JobPosting {
  return {
    id: "posting-1",
    source: "moka",
    sourceJobId: "source-1",
    canonicalUrl,
    title: "Java Engineer",
    organization: "Example",
    description: "Synthetic job description",
    requirements,
    adapterVersion: "moka-job-v1",
    contentHash: "posting-hash",
    extractedAt: "2026-08-16T00:00:00.000Z"
  };
}

describe("job-match-v1 requirement assessment", () => {
  it("marks only explicit incompatibility as conflict", () => {
    const explicitMismatch = requirement("location", "location", false, "上海");
    expect(assessRequirement(explicitMismatch, [], expectation)).toEqual({
      requirementId: "location",
      outcome: "conflict",
      reasonCode: "required_expectation_mismatch"
    });

    const requiredDegree = requirement("degree", "education", true, "本科");
    expect(assessRequirement(requiredDegree, [], expectation).outcome).toBe("unknown");
  });

  it("requires confirmed contradictory evidence for a profile hard conflict", () => {
    const requiredSkill = requirement("java", "skill", true, "java");
    expect(assessRequirement(requiredSkill, [evidence("java", "normalized_fact", "contradicts")], expectation).outcome)
      .toBe("unknown");
    expect(assessRequirement(requiredSkill, [evidence("java", "confirmed_fact", "contradicts")], expectation).outcome)
      .toBe("conflict");
  });
});

describe("job-match-v1 scoring", () => {
  const requirements = [
    requirement("skill", "skill"),
    requirement("responsibility", "responsibility"),
    requirement("project", "project"),
    requirement("education-1", "education"),
    requirement("education-2", "major"),
    requirement("education-3", "experience_years"),
    requirement("preference-conflict", "location", false, "上海"),
    requirement("preference-1", "employment_type", false, "实习"),
    requirement("preference-2", "industry", false, "制造"),
    requirement("preference-3", "work_mode", false, "远程")
  ];
  const scoringEvidence: ScoringEvidence[] = [
    evidence("skill", "normalized_fact", "contradicts"),
    evidence("responsibility", "normalized_fact"),
    evidence("project", "dense"),
    evidence("education-1", "normalized_fact"),
    evidence("education-2", "dense"),
    evidence("education-3", "dense")
  ];

  it("uses the fixed weights, outcomes, and legal evidence qualities", () => {
    const result = scoreJobMatch({
      sessionId: "session-1",
      posting: posting(requirements),
      expectation,
      profileRevision: 7,
      evidence: scoringEvidence
    });

    expect(result).toMatchObject({
      fitScore: 75,
      confidence: 65.5,
      rankingScore: 68.53,
      scoringVersion: "job-match-v1",
      profileRevision: 7,
      expectationRevision: 4,
      postingContentHash: "posting-hash",
      canonicalUrl: "https://jobs.example/a",
      hasConflict: true
    });
    expect(result.outcomes).toHaveLength(requirements.length);
    expect(result.evidence.find((item) => item.requirementId === "skill")?.quality).toBe(0.8);
    expect(result.gaps.some((item) => item.requirementId === "skill")).toBe(true);
  });

  it("renormalizes only dimensions present in the posting", () => {
    const result = scoreJobMatch({
      sessionId: "session-1",
      posting: posting([
        requirement("skill-known", "skill"),
        requirement("project-unknown", "project")
      ]),
      expectation,
      profileRevision: 7,
      evidence: [evidence("skill-known", "confirmed_fact")]
    });

    expect(result.fitScore).toBe(81.82);
    expect(result.confidence).toBe(63.64);
    expect(result.rankingScore).toBe(74.38);
  });

  it("is byte-stable and breaks score ties by canonical URL", () => {
    const input = {
      sessionId: "session-1",
      posting: posting(requirements),
      expectation,
      profileRevision: 7,
      evidence: scoringEvidence
    };
    const baseline = JSON.stringify(scoreJobMatch(input));
    for (let index = 0; index < 100; index += 1) {
      expect(JSON.stringify(scoreJobMatch(input))).toBe(baseline);
    }

    const right = scoreJobMatch({ ...input, posting: posting(requirements, "https://b.example") });
    const left = scoreJobMatch({ ...input, posting: posting(requirements, "https://a.example") });
    expect(sortJobMatches([right, left]).map((item) => item.canonicalUrl)).toEqual([
      "https://a.example",
      "https://b.example"
    ]);
  });
});
