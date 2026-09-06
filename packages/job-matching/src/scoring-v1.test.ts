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

function scoringInput(requirements: JobRequirement[], scoringEvidence: ScoringEvidence[] = []) {
  return {
    sessionId: "session-1",
    posting: posting(requirements),
    expectation,
    profileRevision: 7,
    evidence: scoringEvidence
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

  it("treats a nationwide location preference as unrestricted", () => {
    const nationwide = {
      ...expectation,
      criteria: expectation.criteria.map((criterion) => criterion.kind === "location"
        ? { ...criterion, values: ["\u5168\u56fd"] }
        : criterion)
    };

    expect(assessRequirement(requirement("location", "location", false, "深圳"), [], nationwide)).toEqual({
      requirementId: "location",
      outcome: "satisfied",
      reasonCode: "expectation_match"
    });
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
      fitScore: 57.5,
      confidence: 65.5,
      rankingScore: 52.54,
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

    expect(result.fitScore).toBe(63.64);
    expect(result.confidence).toBe(63.64);
    expect(result.rankingScore).toBe(57.86);
  });

  it("awards zero fit points when the only requirement is unknown", () => {
    const result = scoreJobMatch(scoringInput([
      requirement("skill-unknown", "skill")
    ]));

    expect(result.fitScore).toBe(0);
    expect(result.scoreBreakdown).toEqual({
      total: 0,
      dimensions: [{
        dimension: "skill",
        label: "技能",
        earned: 0,
        available: 100,
        satisfied: 0,
        unknown: 1,
        conflict: 0
      }]
    });
  });

  it("retains full fit points when the only requirement is satisfied", () => {
    const result = scoreJobMatch(scoringInput(
      [requirement("skill-satisfied", "skill")],
      [evidence("skill-satisfied", "confirmed_fact")]
    ));

    expect(result.fitScore).toBe(100);
    expect(result.scoreBreakdown?.dimensions[0]).toMatchObject({
      earned: 100,
      available: 100,
      satisfied: 1,
      unknown: 0,
      conflict: 0
    });
  });

  it("splits one dimension evenly across multiple requirements", () => {
    const result = scoreJobMatch(scoringInput(
      [
        requirement("skill-satisfied", "skill"),
        requirement("skill-unknown", "skill")
      ],
      [evidence("skill-satisfied", "confirmed_fact")]
    ));

    expect(result.fitScore).toBe(50);
    expect(result.scoreBreakdown?.dimensions).toEqual([{
      dimension: "skill",
      label: "技能",
      earned: 50,
      available: 100,
      satisfied: 1,
      unknown: 1,
      conflict: 0
    }]);
  });

  it("normalizes the dimensions present in the posting to 100 points", () => {
    const result = scoreJobMatch(scoringInput(
      [
        requirement("skill-satisfied", "skill"),
        requirement("qualification-satisfied", "education")
      ],
      [
        evidence("skill-satisfied", "confirmed_fact"),
        evidence("qualification-satisfied", "confirmed_fact")
      ]
    ));

    expect(result.fitScore).toBe(100);
    expect(result.scoreBreakdown?.dimensions).toEqual([
      expect.objectContaining({ dimension: "skill", earned: 77.78, available: 77.78 }),
      expect.objectContaining({ dimension: "qualification", earned: 22.22, available: 22.22 })
    ]);
  });

  it("returns a zero score and empty breakdown when no requirements are scorable", () => {
    const result = scoreJobMatch(scoringInput([
      requirement("uncategorized", "other")
    ]));

    expect(result.fitScore).toBe(0);
    expect(result.scoreBreakdown).toEqual({ total: 0, dimensions: [] });
  });

  it("keeps two-decimal dimension totals equal to the authoritative fit score", () => {
    const result = scoreJobMatch(scoringInput(
      [
        requirement("skill-1", "skill"),
        requirement("skill-2", "skill"),
        requirement("skill-3", "skill"),
        requirement("responsibility-1", "responsibility"),
        requirement("responsibility-2", "responsibility"),
        requirement("project-unknown", "project")
      ],
      [
        evidence("skill-1", "confirmed_fact"),
        evidence("responsibility-1", "confirmed_fact")
      ]
    ));

    expect(result.fitScore).toBe(30.21);
    expect(result.scoreBreakdown?.total).toBe(result.fitScore);
    expect(result.scoreBreakdown?.dimensions.map(({ dimension, earned, available }) => ({
      dimension,
      earned,
      available
    }))).toEqual([
      { dimension: "skill", earned: 14.58, available: 43.75 },
      { dimension: "responsibility", earned: 15.63, available: 31.25 },
      { dimension: "project", earned: 0, available: 25 }
    ]);
    expect(result.scoreBreakdown?.dimensions.reduce((total, dimension) => total + dimension.earned, 0))
      .toBe(result.fitScore);
  });

  it("sorts by displayed fit before persisted ranking score", () => {
    const lowFitHighConfidence = {
      fitScore: 70,
      confidence: 100,
      rankingScore: 70,
      canonicalUrl: "https://a.example"
    };
    const highFitLowConfidence = {
      fitScore: 80,
      confidence: 20,
      rankingScore: 60,
      canonicalUrl: "https://b.example"
    };

    expect(sortJobMatches([lowFitHighConfidence, highFitLowConfidence])[0]).toBe(highFitLowConfidence);
  });

  it("breaks fit ties by confidence before canonical URL", () => {
    const lowConfidence = {
      fitScore: 80,
      confidence: 70,
      rankingScore: 100,
      canonicalUrl: "https://a.example"
    };
    const highConfidence = {
      fitScore: 80,
      confidence: 90,
      rankingScore: 10,
      canonicalUrl: "https://b.example"
    };

    expect(sortJobMatches([lowConfidence, highConfidence])[0]).toBe(highConfidence);
  });

  it("breaks fit and confidence ties by canonical URL", () => {
    const right = {
      fitScore: 80,
      confidence: 90,
      rankingScore: 100,
      canonicalUrl: "https://b.example"
    };
    const left = {
      fitScore: 80,
      confidence: 90,
      rankingScore: 10,
      canonicalUrl: "https://a.example"
    };

    expect(sortJobMatches([right, left])).toEqual([left, right]);
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
